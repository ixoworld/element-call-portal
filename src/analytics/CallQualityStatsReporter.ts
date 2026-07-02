/*
Copyright 2026 ixo

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  ConnectionQuality,
  type LocalTrack,
  type RemoteTrack,
  type Room as LivekitRoom,
} from "livekit-client";
import { logger as rootLogger } from "matrix-js-sdk/lib/logger";

import { PosthogAnalytics } from "./PosthogAnalytics";
import { type CallQualityStatsPayload } from "./PosthogEvents";

const logger = rootLogger.getChild("[CallQualityStatsReporter]");

/**
 * How often we poll `getStats()` on each track. This is cheap and local; it
 * never results in a network request. Deltas between polls are used to derive
 * bitrate and packet-loss rates.
 */
const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
/**
 * How often an aggregated {@link CallQualityStatsPayload} event is sent to
 * PostHog. We deliberately do NOT send a per-sample (1 Hz) event: that would be
 * far too many events and expensive. Instead we aggregate many samples into one
 * event per flush window (default 30s), plus a single final summary at the end
 * of the call.
 */
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

/** Thresholds used to count "bad" samples for the *max* fields. */
const roundTo = (value: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
};

/** Loosely-typed accessor for optional RTCStats fields not in every lib.dom. */
type LooseStats = Record<string, unknown> & { type: string; id: string };
const num = (o: Record<string, unknown>, key: string): number | undefined => {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};
const str = (o: Record<string, unknown>, key: string): string | undefined => {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
};

/** Running average + max for a single scalar metric. */
class Scalar {
  private sum = 0;
  private count = 0;
  public max = 0;
  public add(value: number): void {
    this.sum += value;
    this.count += 1;
    if (value > this.max) this.max = value;
  }
  public get avg(): number {
    return this.count > 0 ? this.sum / this.count : 0;
  }
}

/**
 * Accumulates derived per-sample metrics. Two instances are kept per reporter:
 * one for the current flush window (reset after each flush) and one for the
 * whole call (used for the final summary).
 */
class Accumulator {
  public startMs: number;
  public sampleCount = 0;

  // Receive (inbound) — aggregated across all remote tracks.
  public recvBytes = 0;
  public recvPacketsLost = 0;
  public recvPackets = 0;
  public recvPacketLossPctMax = 0;
  public readonly recvJitterMs = new Scalar();
  public readonly recvFps = new Scalar();
  public recvFreezeCount = 0;
  public recvFreezeMs = 0;

  // Send (outbound) — aggregated across all local tracks.
  public sendBytes = 0;
  public sendPacketsLost = 0;
  public sendPackets = 0;
  public sendPacketLossPctMax = 0;
  public readonly sendFps = new Scalar();
  public sendWidth = 0;
  public sendHeight = 0;
  public limitCpuSec = 0;
  public limitBandwidthSec = 0;
  public limitOtherSec = 0;

  // Transport.
  public readonly rttMs = new Scalar();
  public turnSamples = 0;
  public transportSamples = 0;

  // High-level LiveKit connection quality gauge.
  public readonly connQuality: Record<ConnectionQuality, number> = {
    [ConnectionQuality.Excellent]: 0,
    [ConnectionQuality.Good]: 0,
    [ConnectionQuality.Poor]: 0,
    [ConnectionQuality.Lost]: 0,
    [ConnectionQuality.Unknown]: 0,
  };

  public maxRemoteParticipants = 0;
  public readonly sfuHosts = new Set<string>();

  public constructor(nowMs: number) {
    this.startMs = nowMs;
  }

  public addRecv(
    bytesDelta: number,
    packetsDelta: number,
    lostDelta: number,
    jitterMs: number | undefined,
    fps: number | undefined,
    freezeCountDelta: number,
    freezeMsDelta: number,
  ): void {
    this.recvBytes += bytesDelta;
    this.recvPackets += packetsDelta;
    this.recvPacketsLost += lostDelta;
    const denom = packetsDelta + lostDelta;
    if (denom > 0) {
      const inst = (lostDelta / denom) * 100;
      if (inst > this.recvPacketLossPctMax) this.recvPacketLossPctMax = inst;
    }
    if (jitterMs !== undefined) this.recvJitterMs.add(jitterMs);
    if (fps !== undefined) this.recvFps.add(fps);
    this.recvFreezeCount += freezeCountDelta;
    this.recvFreezeMs += freezeMsDelta;
  }

  public addSend(
    bytesDelta: number,
    packetsDelta: number,
    lostDelta: number,
    fps: number | undefined,
    width: number | undefined,
    height: number | undefined,
    cpuSecDelta: number,
    bandwidthSecDelta: number,
    otherSecDelta: number,
  ): void {
    this.sendBytes += bytesDelta;
    this.sendPackets += packetsDelta;
    this.sendPacketsLost += lostDelta;
    const denom = packetsDelta + lostDelta;
    if (denom > 0) {
      const inst = (lostDelta / denom) * 100;
      if (inst > this.sendPacketLossPctMax) this.sendPacketLossPctMax = inst;
    }
    if (fps !== undefined) this.sendFps.add(fps);
    if (width !== undefined && width > this.sendWidth) this.sendWidth = width;
    if (height !== undefined && height > this.sendHeight)
      this.sendHeight = height;
    this.limitCpuSec += cpuSecDelta;
    this.limitBandwidthSec += bandwidthSecDelta;
    this.limitOtherSec += otherSecDelta;
  }

  public addRtt(ms: number): void {
    this.rttMs.add(ms);
  }

  public addTransport(usesTurn: boolean): void {
    this.transportSamples += 1;
    if (usesTurn) this.turnSamples += 1;
  }

  public addConnQuality(q: ConnectionQuality): void {
    this.connQuality[q] += 1;
  }
}

const worstConnQuality = (
  counts: Record<ConnectionQuality, number>,
): ConnectionQuality => {
  for (const q of [
    ConnectionQuality.Lost,
    ConnectionQuality.Poor,
    ConnectionQuality.Good,
    ConnectionQuality.Excellent,
  ]) {
    if (counts[q] > 0) return q;
  }
  return ConnectionQuality.Unknown;
};

const buildPayload = (
  callId: string,
  acc: Accumulator,
  nowMs: number,
  isFinal: boolean,
): CallQualityStatsPayload => {
  const windowSeconds = Math.max((nowMs - acc.startMs) / 1000, 0.001);
  const recvLossDenom = acc.recvPackets + acc.recvPacketsLost;
  const sendLossDenom = acc.sendPackets + acc.sendPacketsLost;
  const totalConn =
    acc.connQuality[ConnectionQuality.Excellent] +
    acc.connQuality[ConnectionQuality.Good] +
    acc.connQuality[ConnectionQuality.Poor] +
    acc.connQuality[ConnectionQuality.Lost];
  const poorOrLost =
    acc.connQuality[ConnectionQuality.Poor] +
    acc.connQuality[ConnectionQuality.Lost];
  const limitTotal =
    acc.limitCpuSec + acc.limitBandwidthSec + acc.limitOtherSec;

  return {
    callId,
    isFinal,
    sampleWindowSeconds: roundTo(windowSeconds, 1),
    sampleCount: acc.sampleCount,
    numRemoteParticipants: acc.maxRemoteParticipants,
    numSfuHosts: acc.sfuHosts.size,
    sfuHosts: [...acc.sfuHosts].join(","),
    connectionQualityWorst: worstConnQuality(acc.connQuality),
    connectionQualityPoorPct:
      totalConn > 0 ? roundTo((poorOrLost / totalConn) * 100, 1) : 0,

    recvBitrateKbps: roundTo((acc.recvBytes * 8) / 1000 / windowSeconds, 0),
    recvPacketLossPct:
      recvLossDenom > 0
        ? roundTo((acc.recvPacketsLost / recvLossDenom) * 100, 2)
        : 0,
    recvPacketLossPctMax: roundTo(acc.recvPacketLossPctMax, 2),
    recvJitterMs: roundTo(acc.recvJitterMs.avg, 1),
    recvJitterMsMax: roundTo(acc.recvJitterMs.max, 1),
    recvFps: roundTo(acc.recvFps.avg, 1),
    recvFreezeCount: acc.recvFreezeCount,
    recvFreezeMs: roundTo(acc.recvFreezeMs, 0),

    sendBitrateKbps: roundTo((acc.sendBytes * 8) / 1000 / windowSeconds, 0),
    sendPacketLossPct:
      sendLossDenom > 0
        ? roundTo((acc.sendPacketsLost / sendLossDenom) * 100, 2)
        : 0,
    sendPacketLossPctMax: roundTo(acc.sendPacketLossPctMax, 2),
    sendFps: roundTo(acc.sendFps.avg, 1),
    sendResolution:
      acc.sendWidth > 0 && acc.sendHeight > 0
        ? `${acc.sendWidth}x${acc.sendHeight}`
        : "",
    sendLimitedByCpuPct:
      limitTotal > 0 ? roundTo((acc.limitCpuSec / limitTotal) * 100, 1) : 0,
    sendLimitedByBandwidthPct:
      limitTotal > 0
        ? roundTo((acc.limitBandwidthSec / limitTotal) * 100, 1)
        : 0,

    rttMs: roundTo(acc.rttMs.avg, 0),
    rttMsMax: roundTo(acc.rttMs.max, 0),
    usesTurnRelayPct:
      acc.transportSamples > 0
        ? roundTo((acc.turnSamples / acc.transportSamples) * 100, 0)
        : 0,
  };
};

/** Cumulative counters kept between samples so we can compute deltas. */
interface PrevCounters {
  bytes: number;
  packets: number;
  lost: number;
  freezeCount: number;
  freezeMs: number;
  cpuSec: number;
  bandwidthSec: number;
  otherSec: number;
}

export interface CallQualityStatsReporterOptions {
  sampleIntervalMs?: number;
  flushIntervalMs?: number;
}

/** A LiveKit room plus its SFU service URL (as exposed by the CallViewModel). */
export interface SampledRoom {
  livekitRoom: LivekitRoom;
  url: string;
}

/**
 * Collects per-participant WebRTC statistics from the LiveKit room(s), derives
 * connection-quality metrics (packet loss, jitter, RTT, freezes, bitrate,
 * send-side quality limitation, TURN usage) and reports them to PostHog as an
 * aggregated {@link CallQualityStatsPayload} event — never per sample.
 *
 * This is what lets us tell apart the three common causes of bad calls:
 *  - a single user's poor network (their recv/send loss + RTT are bad while
 *    everyone else is fine, often via a TURN relay),
 *  - an SFU/server problem (many users on the same SFU host degrade together),
 *  - local CPU limits (`sendLimitedByCpuPct`).
 */
export class CallQualityStatsReporter {
  private readonly sampleIntervalMs: number;
  private readonly flushIntervalMs: number;
  private rooms: SampledRoom[] = [];
  private windowAcc: Accumulator;
  private callAcc: Accumulator;
  private readonly prev = new Map<string, PrevCounters>();
  private sampleTimer?: ReturnType<typeof setInterval>;
  private flushTimer?: ReturnType<typeof setInterval>;
  private sampling = false;
  private started = false;

  public constructor(
    private readonly callId: string,
    options: CallQualityStatsReporterOptions = {},
  ) {
    this.sampleIntervalMs =
      options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    const now = Date.now();
    this.windowAcc = new Accumulator(now);
    this.callAcc = new Accumulator(now);
  }

  /** Update the set of LiveKit rooms to sample (supports multi-SFU). */
  public setRooms(rooms: SampledRoom[]): void {
    this.rooms = rooms;
  }

  public start(): void {
    // Nothing will be captured if the user hasn't consented to analytics, so
    // don't even run the timers in that case.
    if (this.started || !PosthogAnalytics.instance.isEnabled()) return;
    this.started = true;
    const now = Date.now();
    this.windowAcc = new Accumulator(now);
    this.callAcc = new Accumulator(now);
    this.sampleTimer = setInterval(() => {
      void this.sample();
    }, this.sampleIntervalMs);
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    logger.info(`Started call quality stats reporter for ${this.callId}`);
  }

  public stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.sampleTimer = undefined;
    this.flushTimer = undefined;
    // Emit a single final, whole-call summary (this already includes any
    // samples from the current partial window, so we don't flush that
    // separately and create a duplicate).
    if (this.callAcc.sampleCount > 0) {
      PosthogAnalytics.instance.eventCallQualityStats.track(
        buildPayload(this.callId, this.callAcc, Date.now(), true),
      );
    }
    this.prev.clear();
    logger.info(`Stopped call quality stats reporter for ${this.callId}`);
  }

  private forEachAcc(fn: (a: Accumulator) => void): void {
    fn(this.windowAcc);
    fn(this.callAcc);
  }

  private flush(): void {
    if (this.windowAcc.sampleCount === 0) return;
    PosthogAnalytics.instance.eventCallQualityStats.track(
      buildPayload(this.callId, this.windowAcc, Date.now(), false),
    );
    this.windowAcc = new Accumulator(Date.now());
  }

  private async sample(): Promise<void> {
    // Guard against overlapping samples if getStats is slow.
    if (this.sampling) return;
    this.sampling = true;
    try {
      let remoteParticipants = 0;
      this.forEachAcc((a) => a.sampleCount++);

      for (let r = 0; r < this.rooms.length; r++) {
        const { livekitRoom: room, url } = this.rooms[r];
        const host = hostOf(url);
        if (host) this.forEachAcc((a) => a.sfuHosts.add(host));

        // Local (outbound) tracks + publisher-side transport.
        const local = room.localParticipant;
        for (const pub of local.getTrackPublications()) {
          const track = pub.track as LocalTrack | undefined;
          await this.sampleTrack(`${r}|out`, track, "out");
        }

        // Remote (inbound) tracks + subscriber-side transport.
        for (const participant of room.remoteParticipants.values()) {
          remoteParticipants++;
          this.forEachAcc((a) => a.addConnQuality(participant.connectionQuality));
          for (const pub of participant.getTrackPublications()) {
            const track = pub.track as RemoteTrack | undefined;
            await this.sampleTrack(
              `${r}|in|${participant.identity}`,
              track,
              "in",
            );
          }
        }
      }

      this.forEachAcc((a) => {
        if (remoteParticipants > a.maxRemoteParticipants)
          a.maxRemoteParticipants = remoteParticipants;
      });
    } catch (e) {
      logger.warn("Failed to sample call quality stats", e);
    } finally {
      this.sampling = false;
    }
  }

  private async sampleTrack(
    keyPrefix: string,
    track: LocalTrack | RemoteTrack | undefined,
    direction: "in" | "out",
  ): Promise<void> {
    if (!track) return;
    let report: RTCStatsReport | undefined;
    try {
      report = await track.getRTCStatsReport();
    } catch {
      return;
    }
    if (!report) return;

    // Candidate-pair + candidate stats are transport-wide (per PeerConnection),
    // so only process them once per report via a stable key.
    let selectedPair: LooseStats | undefined;
    const candidates = new Map<string, LooseStats>();

    report.forEach((raw) => {
      const s = raw as unknown as LooseStats;
      switch (s.type) {
        case "inbound-rtp":
          if (direction === "in") this.handleInbound(keyPrefix, s);
          break;
        case "outbound-rtp":
          if (direction === "out") this.handleOutbound(keyPrefix, s);
          break;
        case "remote-inbound-rtp":
          // Reported by the remote peer about our outbound stream: gives us
          // send-side packet loss and RTT.
          if (direction === "out") this.handleRemoteInbound(keyPrefix, s);
          break;
        case "candidate-pair":
          if (isSelectedPair(s)) selectedPair = s;
          break;
        case "local-candidate":
        case "remote-candidate":
          candidates.set(s.id, s);
          break;
      }
    });

    if (selectedPair) {
      const rtt = num(selectedPair, "currentRoundTripTime");
      if (rtt !== undefined) this.forEachAcc((a) => a.addRtt(rtt * 1000));
      const localId = str(selectedPair, "localCandidateId");
      const localCand = localId ? candidates.get(localId) : undefined;
      const usesTurn =
        localCand !== undefined && str(localCand, "candidateType") === "relay";
      this.forEachAcc((a) => a.addTransport(usesTurn));
    }
  }

  private handleInbound(keyPrefix: string, s: LooseStats): void {
    const key = `${keyPrefix}|in|${s.id}`;
    const bytes = num(s, "bytesReceived") ?? 0;
    const packets = num(s, "packetsReceived") ?? 0;
    const lost = num(s, "packetsLost") ?? 0;
    const freezeCount = num(s, "freezeCount") ?? 0;
    const freezeMs = (num(s, "totalFreezesDuration") ?? 0) * 1000;
    const prev = this.prev.get(key);
    this.prev.set(key, {
      bytes,
      packets,
      lost,
      freezeCount,
      freezeMs,
      cpuSec: 0,
      bandwidthSec: 0,
      otherSec: 0,
    });
    if (!prev) return; // need two samples to compute a delta

    const jitterMs = mul(num(s, "jitter"), 1000);
    const fps = num(s, "framesPerSecond");
    this.forEachAcc((a) =>
      a.addRecv(
        Math.max(bytes - prev.bytes, 0),
        Math.max(packets - prev.packets, 0),
        Math.max(lost - prev.lost, 0),
        jitterMs,
        fps,
        Math.max(freezeCount - prev.freezeCount, 0),
        Math.max(freezeMs - prev.freezeMs, 0),
      ),
    );
  }

  private handleOutbound(keyPrefix: string, s: LooseStats): void {
    const key = `${keyPrefix}|out|${s.id}`;
    const bytes = num(s, "bytesSent") ?? 0;
    const packets = num(s, "packetsSent") ?? 0;
    const durations = (s["qualityLimitationDurations"] ?? {}) as Record<
      string,
      unknown
    >;
    const cpuSec = num(durations, "cpu") ?? 0;
    const bandwidthSec = num(durations, "bandwidth") ?? 0;
    const otherSec = (num(durations, "other") ?? 0) + (num(durations, "none") ?? 0);
    const prev = this.prev.get(key);
    this.prev.set(key, {
      bytes,
      packets,
      lost: 0,
      freezeCount: 0,
      freezeMs: 0,
      cpuSec,
      bandwidthSec,
      otherSec,
    });
    if (!prev) return;

    const fps = num(s, "framesPerSecond");
    const width = num(s, "frameWidth");
    const height = num(s, "frameHeight");
    this.forEachAcc((a) =>
      a.addSend(
        Math.max(bytes - prev.bytes, 0),
        Math.max(packets - prev.packets, 0),
        0, // send loss comes from remote-inbound-rtp, handled separately
        fps,
        width,
        height,
        Math.max(cpuSec - prev.cpuSec, 0),
        Math.max(bandwidthSec - prev.bandwidthSec, 0),
        Math.max(otherSec - prev.otherSec, 0),
      ),
    );
  }

  private handleRemoteInbound(keyPrefix: string, s: LooseStats): void {
    const key = `${keyPrefix}|rin|${s.id}`;
    const lost = num(s, "packetsLost") ?? 0;
    const prev = this.prev.get(key);
    this.prev.set(key, {
      bytes: 0,
      packets: 0,
      lost,
      freezeCount: 0,
      freezeMs: 0,
      cpuSec: 0,
      bandwidthSec: 0,
      otherSec: 0,
    });
    const rtt = num(s, "roundTripTime");
    if (rtt !== undefined) this.forEachAcc((a) => a.addRtt(rtt * 1000));
    if (!prev) return;
    const lostDelta = Math.max(lost - prev.lost, 0);
    // Attribute the loss against outbound packets in the same window by feeding
    // it as a send-loss-only sample (packetsDelta 0 keeps the weighting sane
    // because outbound packets are already counted via handleOutbound).
    if (lostDelta > 0)
      this.forEachAcc((a) => {
        a.sendPacketsLost += lostDelta;
      });
  }
}

const mul = (v: number | undefined, factor: number): number | undefined =>
  v === undefined ? undefined : v * factor;

const isSelectedPair = (s: LooseStats): boolean => {
  // Chrome exposes `nominated`; some browsers expose `selected`.
  if (s["nominated"] === true || s["selected"] === true) {
    return str(s, "state") === "succeeded" || s["state"] === undefined;
  }
  return false;
};

const hostOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};

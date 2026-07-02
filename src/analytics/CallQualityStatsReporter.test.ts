/*
Copyright 2026 ixo

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { ConnectionQuality, type Room as LivekitRoom } from "livekit-client";

import { PosthogAnalytics } from "./PosthogAnalytics";
import { type CallQualityStatsPayload } from "./PosthogEvents";
import {
  CallQualityStatsReporter,
  type SampledRoom,
} from "./CallQualityStatsReporter";
import { mockConfig } from "../utils/test";

/**
 * Builds a fake RTCStatsReport (a Map is structurally compatible: the reporter
 * only relies on `.forEach`). Values are cumulative and grow with `n` so that
 * consecutive samples yield known deltas.
 */
const localReport = (n: number): RTCStatsReport =>
  new Map<string, unknown>([
    [
      "out1",
      {
        id: "out1",
        type: "outbound-rtp",
        bytesSent: 20000 * n,
        packetsSent: 200 * n,
        framesPerSecond: 30,
        frameWidth: 1280,
        frameHeight: 720,
        qualityLimitationDurations: {
          cpu: 0,
          bandwidth: 1 * n,
          other: 0,
          none: 4 * n,
        },
      },
    ],
    [
      "rin1",
      {
        id: "rin1",
        type: "remote-inbound-rtp",
        packetsLost: 2 * n,
        roundTripTime: 0.05,
      },
    ],
    [
      "cp",
      {
        id: "cp",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 0.04,
        localCandidateId: "lc1",
      },
    ],
    ["lc1", { id: "lc1", type: "local-candidate", candidateType: "relay" }],
  ]) as unknown as RTCStatsReport;

const remoteReport = (n: number): RTCStatsReport =>
  new Map<string, unknown>([
    [
      "in1",
      {
        id: "in1",
        type: "inbound-rtp",
        bytesReceived: 10000 * n,
        packetsReceived: 100 * n,
        packetsLost: 1 * n,
        jitter: 0.02,
        framesPerSecond: 30,
        freezeCount: n,
        totalFreezesDuration: 0.1 * n,
      },
    ],
    [
      "cp",
      {
        id: "cp",
        type: "candidate-pair",
        nominated: true,
        state: "succeeded",
        currentRoundTripTime: 0.04,
        localCandidateId: "lc1",
      },
    ],
    ["lc1", { id: "lc1", type: "local-candidate", candidateType: "relay" }],
  ]) as unknown as RTCStatsReport;

/** A fake LiveKit room with one local outbound track and one remote member. */
const makeRoom = (): SampledRoom => {
  let localTick = 0;
  let remoteTick = 0;
  const localTrack = {
    getRTCStatsReport: async (): Promise<RTCStatsReport> =>
      await Promise.resolve(localReport(++localTick)),
  };
  const remoteTrack = {
    getRTCStatsReport: async (): Promise<RTCStatsReport> =>
      await Promise.resolve(remoteReport(++remoteTick)),
  };
  const room = {
    localParticipant: {
      getTrackPublications: (): { track: typeof localTrack }[] => [
        { track: localTrack },
      ],
    },
    remoteParticipants: new Map([
      [
        "@remote:hs",
        {
          identity: "@remote:hs",
          connectionQuality: ConnectionQuality.Good,
          getTrackPublications: (): { track: typeof remoteTrack }[] => [
            { track: remoteTrack },
          ],
        },
      ],
    ]),
  } as unknown as LivekitRoom;
  return { livekitRoom: room, url: "https://sfu.example.com/foci" };
};

describe("CallQualityStatsReporter", () => {
  let trackSpy: MockInstance;

  beforeEach(() => {
    mockConfig();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(PosthogAnalytics.instance, "isEnabled").mockReturnValue(true);
    trackSpy = vi
      .spyOn(PosthogAnalytics.instance.eventCallQualityStats, "track")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not run when analytics is disabled", () => {
    (PosthogAnalytics.instance.isEnabled as unknown as MockInstance).mockReturnValue(
      false,
    );
    const reporter = new CallQualityStatsReporter("!room:hs", {
      sampleIntervalMs: 1000,
      flushIntervalMs: 100000,
    });
    reporter.setRooms([makeRoom()]);
    reporter.start();
    vi.advanceTimersByTime(5000);
    reporter.stop();
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it("aggregates many samples into a single final event (never per-sample)", async () => {
    const reporter = new CallQualityStatsReporter("!room:hs", {
      sampleIntervalMs: 1000,
      // Large flush window so only the end-of-call summary is emitted here.
      flushIntervalMs: 100000,
    });
    reporter.setRooms([makeRoom()]);
    reporter.start();

    // 5 samples at t = 1s..5s.
    await vi.advanceTimersByTimeAsync(5000);
    reporter.stop();

    // Five polls collapsed into exactly one event — the cost guarantee.
    expect(trackSpy).toHaveBeenCalledTimes(1);
    const p = trackSpy.mock.calls[0][0] as CallQualityStatsPayload;

    expect(p.isFinal).toBe(true);
    expect(p.sampleCount).toBe(5);
    expect(p.sampleWindowSeconds).toBe(5);
    expect(p.numRemoteParticipants).toBe(1);
    expect(p.sfuHosts).toBe("sfu.example.com");
    expect(p.connectionQualityWorst).toBe("good");

    // 4 delta-intervals of 10000 B recv / 20000 B sent over 5 s.
    expect(p.recvBitrateKbps).toBeCloseTo(64, 0);
    expect(p.sendBitrateKbps).toBeCloseTo(128, 0);

    // recv loss 4 lost / 400 received; send loss 8 lost / 800 sent.
    expect(p.recvPacketLossPct).toBeCloseTo(0.99, 1);
    expect(p.sendPacketLossPct).toBeCloseTo(0.99, 1);

    expect(p.recvJitterMs).toBeCloseTo(20, 0);
    expect(p.recvFreezeCount).toBe(4);
    expect(p.recvFreezeMs).toBeCloseTo(400, 0);
    expect(p.sendResolution).toBe("1280x720");
    expect(p.sendLimitedByBandwidthPct).toBeCloseTo(20, 0);
    expect(p.sendLimitedByCpuPct).toBe(0);

    expect(p.rttMsMax).toBe(50);
    expect(p.usesTurnRelayPct).toBe(100);
  });

  it("emits a periodic window event and a final event", async () => {
    const reporter = new CallQualityStatsReporter("!room:hs", {
      sampleIntervalMs: 1000,
      flushIntervalMs: 3000,
    });
    reporter.setRooms([makeRoom()]);
    reporter.start();

    // One flush at t=3s (covering samples at 1s,2s,3s), then stop for the final.
    await vi.advanceTimersByTimeAsync(3500);
    reporter.stop();

    expect(trackSpy).toHaveBeenCalledTimes(2);
    const first = trackSpy.mock.calls[0][0] as CallQualityStatsPayload;
    const last = trackSpy.mock.calls[1][0] as CallQualityStatsPayload;
    expect(first.isFinal).toBe(false);
    expect(last.isFinal).toBe(true);
  });
});

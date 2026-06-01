/*
Copyright 2023, 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  AudioPresets,
  DefaultReconnectPolicy,
  type RoomOptions,
  ScreenSharePresets,
  type TrackPublishDefaults,
  type VideoPreset,
  VideoPresets,
} from "livekit-client";

const defaultLiveKitPublishOptions: TrackPublishDefaults = {
  // Voice-optimized Opus at 24kbps instead of the 48kbps "music" preset. The
  // music preset faithfully reproduces background noise (typing, fans); the
  // speech preset is tuned for voice and audibly reduces how crisply that
  // noise comes through. Native browser noise suppression / echo cancellation /
  // AGC stay enabled (set per-capture in ConnectionFactory, defaulting to on).
  audioPreset: AudioPresets.speech,
  dtx: true,
  // disable red because the livekit server strips out red packets for clients
  // that don't support it (firefox) but of course that doesn't work with e2ee.
  red: false,
  forceStereo: false,
  simulcast: true,
  videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360] as VideoPreset[],
  // Lower screen-share ceiling: 1080p15 @ 2.5Mbps gives sharper text per bit
  // than 1080p30 @ 5Mbps and is far easier on publisher CPU.
  screenShareEncoding: ScreenSharePresets.h1080fps15.encoding,
  // Provide a real mid-tier layer so the SFU isn't stuck choosing between
  // blurry 540p and full 1080p. Order: low → high.
  screenShareSimulcastLayers: [
    ScreenSharePresets.h360fps3,
    ScreenSharePresets.h720fps5,
  ] as VideoPreset[],
  stopMicTrackOnMute: false,
  // VP9 (SVC L3T3) for camera: better quality per bit than VP8 and degrades
  // more smoothly (temporal layers drop frames instead of hard simulcast layer
  // switches), usually at lower publisher CPU than 3x VP8 simulcast. The VP8
  // backup keeps incompatible subscribers (e.g. older Safari) working.
  // NOTE: screen share deliberately stays on VP8 — see LocalMember.ts, where
  // it pins videoCodec back to "vp8" so contentHint:"detail" still applies.
  videoCodec: "vp9",
  videoEncoding: VideoPresets.h720.encoding,
  backupCodec: { codec: "vp8", encoding: VideoPresets.h720.encoding },
  // Prefer dropping framerate over resolution under bandwidth/CPU pressure —
  // keeps faces/detail sharp rather than going soft to hold 30fps.
  degradationPreference: "maintain-resolution",
} as const;

export const defaultLiveKitOptions: RoomOptions = {
  // automatically manage subscribed video quality
  adaptiveStream: true,

  // optimize publishing bandwidth and CPU for published tracks
  dynacast: true,

  // capture settings
  videoCaptureDefaults: {
    // 720p captured at 24fps: with maintain-resolution this spends bits on
    // sharpness instead of holding 30fps, and eases encoder load.
    resolution: { ...VideoPresets.h720.resolution, frameRate: 24 },
  },

  // publish settings
  publishDefaults: defaultLiveKitPublishOptions,

  // default LiveKit options that seem to be sane
  stopLocalTrackOnUnpublish: true,
  reconnectPolicy: new DefaultReconnectPolicy(),
  disconnectOnPageLeave: true,
  webAudioMix: false,
};

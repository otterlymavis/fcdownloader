/**
 * Native muxing of separate video + audio files into one mp4.
 *
 * Android: stdlib MediaMuxer (see android/.../MediaMuxerModule.kt).
 * iOS:     not yet implemented — throws so the caller can fall back.
 *
 * No external native libraries — Android's MediaMuxer ships with the OS and
 * does a lossless `-c copy` style copy of the sample streams. Compatible
 * containers required (mp4/m4a — both standard for YouTube adaptive formats).
 */
import { NativeModules, Platform } from 'react-native';

const { MediaMuxerModule } = NativeModules as {
  MediaMuxerModule?: {
    mux(videoPath: string, audioPath: string, outputPath: string): Promise<string>;
  };
};

export class MuxNotSupportedError extends Error {
  constructor(msg: string) { super(msg); this.name = 'MuxNotSupportedError'; }
}

/** Mux `videoPath` (video track) + `audioPath` (audio track) → `outputPath` mp4. */
export async function muxVideoAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<void> {
  if (Platform.OS !== 'android' || !MediaMuxerModule) {
    throw new MuxNotSupportedError(
      `Mux not supported on ${Platform.OS}. Add a native AVAssetExport module ` +
      `or accept the video-only file.`,
    );
  }
  await MediaMuxerModule.mux(videoPath, audioPath, outputPath);
}

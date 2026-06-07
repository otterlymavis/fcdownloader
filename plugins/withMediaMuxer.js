/**
 * Expo Config Plugin — iOS Native Media Muxer
 * iOS only — returns config unchanged on Android.
 */
// @ts-check
const { withXcodeProject, createRunOncePlugin } = require('@expo/config-plugins');
const fs   = require('fs');
const path = require('path');

// ── Native source ──────────────────────────────────────────────────────────────

const SWIFT_SOURCE = `\
import Foundation
import AVFoundation
import React

@objc(MediaMuxerModule)
class MediaMuxerModule: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  /// Mux a video-only file + an audio-only file into a single mp4 with no
  /// re-encoding (AVAssetExportPresetPassthrough). Mirrors Android's
  /// MediaMuxer-based implementation.
  @objc(mux:audioPath:outputPath:resolver:rejecter:)
  func mux(_ videoPath: String,
           audioPath: String,
           outputPath: String,
           resolver: @escaping RCTPromiseResolveBlock,
           rejecter: @escaping RCTPromiseRejectBlock) {

    let videoURL  = URL(fileURLWithPath: Self.stripScheme(videoPath))
    let audioURL  = URL(fileURLWithPath: Self.stripScheme(audioPath))
    let outputURL = URL(fileURLWithPath: Self.stripScheme(outputPath))

    try? FileManager.default.removeItem(at: outputURL)

    let composition = AVMutableComposition()
    let videoAsset  = AVURLAsset(url: videoURL)
    let audioAsset  = AVURLAsset(url: audioURL)

    let videoTracks = videoAsset.tracks(withMediaType: .video)
    let audioTracks = audioAsset.tracks(withMediaType: .audio)

    guard let srcVideo = videoTracks.first else {
      rejecter("MUX_NO_VIDEO", "No video track in \\(videoURL.lastPathComponent)", nil); return
    }
    guard let srcAudio = audioTracks.first else {
      rejecter("MUX_NO_AUDIO", "No audio track in \\(audioURL.lastPathComponent)", nil); return
    }

    // Clamp to the shorter of the two so AVAssetExportSession doesn't pad silence/freeze frames.
    let dur = CMTimeMinimum(videoAsset.duration, audioAsset.duration)
    let range = CMTimeRange(start: .zero, duration: dur)

    guard let dstVideo = composition.addMutableTrack(
      withMediaType: .video,
      preferredTrackID: kCMPersistentTrackID_Invalid) else {
      rejecter("MUX_ADD_VIDEO", "Could not add video composition track", nil); return
    }
    guard let dstAudio = composition.addMutableTrack(
      withMediaType: .audio,
      preferredTrackID: kCMPersistentTrackID_Invalid) else {
      rejecter("MUX_ADD_AUDIO", "Could not add audio composition track", nil); return
    }

    do {
      try dstVideo.insertTimeRange(range, of: srcVideo, at: .zero)
      try dstAudio.insertTimeRange(range, of: srcAudio, at: .zero)
    } catch {
      rejecter("MUX_INSERT", "insertTimeRange failed: \\(error.localizedDescription)", error)
      return
    }

    guard let export = AVAssetExportSession(
      asset: composition,
      presetName: AVAssetExportPresetPassthrough) else {
      rejecter("MUX_EXPORT_INIT", "Could not create AVAssetExportSession", nil); return
    }
    export.outputURL = outputURL
    export.outputFileType = .mp4
    export.shouldOptimizeForNetworkUse = true

    export.exportAsynchronously {
      switch export.status {
      case .completed:
        resolver(outputURL.path)
      case .failed, .cancelled:
        let msg = export.error?.localizedDescription ?? "status \\(export.status.rawValue)"
        rejecter("MUX_EXPORT", "Export failed: \\(msg)", export.error)
      default:
        rejecter("MUX_EXPORT", "Unexpected export status: \\(export.status.rawValue)", nil)
      }
    }
  }

  private static func stripScheme(_ p: String) -> String {
    return p.hasPrefix("file://") ? String(p.dropFirst(7)) : p
  }
}
`;

const OBJC_BRIDGE = `\
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(MediaMuxerModule, NSObject)
RCT_EXTERN_METHOD(mux:(NSString *)videoPath
                  audioPath:(NSString *)audioPath
                  outputPath:(NSString *)outputPath
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
@end
`;

// ── File helpers ──────────────────────────────────────────────────────────────

const SUBDIR     = 'MediaMuxer';
const SWIFT_FILE = 'MediaMuxerModule.swift';
const OBJC_FILE  = 'MediaMuxerModule.m';

function writeMuxerFiles(projectRoot) {
  const dir = path.join(projectRoot, 'ios', SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SWIFT_FILE), SWIFT_SOURCE);
  fs.writeFileSync(path.join(dir, OBJC_FILE),  OBJC_BRIDGE);
}

// ── Xcode project manipulation ────────────────────────────────────────────────

function addToXcodeProject(project, appTargetName) {
  // Skip if already added — idempotent across repeated prebuilds.
  const allFiles = project.pbxFileReferenceSection();
  for (const key of Object.keys(allFiles)) {
    const entry = allFiles[key];
    if (typeof entry === 'object' && entry.path && entry.path.includes(SWIFT_FILE)) {
      return;
    }
  }

  // Create a PBX group for the muxer files and attach it to the main group
  const groupResult = project.addPbxGroup(
    [SWIFT_FILE, OBJC_FILE],
    SUBDIR,
    SUBDIR,
  );
  const mainGroupUuid = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(groupResult.uuid, mainGroupUuid);

  const target = project.pbxTargetByName(appTargetName);
  if (!target) {
    throw new Error(`[withMediaMuxer] could not find app target "${appTargetName}"`);
  }
  project.addSourceFile(`${SUBDIR}/${SWIFT_FILE}`, { target: target.uuid });
  project.addSourceFile(`${SUBDIR}/${OBJC_FILE}`,  { target: target.uuid });
}

// ── Plugin definition ─────────────────────────────────────────────────────────

const withMediaMuxerPlugin = (config) => {
  return withXcodeProject(config, async (cfg) => {
    const projectRoot = cfg.modRequest.projectRoot;
    const appTarget   = cfg.modRequest.projectName || 'FCDownloader';

    writeMuxerFiles(projectRoot);
    addToXcodeProject(cfg.modResults, appTarget);

    return cfg;
  });
};

module.exports = createRunOncePlugin(withMediaMuxerPlugin, 'withMediaMuxer', '1.0.0');

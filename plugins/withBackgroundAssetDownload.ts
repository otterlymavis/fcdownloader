/**
 * Expo Config Plugin — Native AVAssetDownloadTask support
 *
 * Activating this plugin requires running `npx expo prebuild` and adding
 * the Swift native module to ios/FCDownloader/HLSDownloadManager.swift
 * (see the implementation guide).
 *
 * This file only patches Info.plist — the Swift/ObjC bridge is separate.
 */
import { ConfigPlugin, withInfoPlist } from '@expo/config-plugins';

const withBackgroundAssetDownload: ConfigPlugin = (config) => {
  return withInfoPlist(config, (c) => {
    // Register the BGProcessingTask identifier used by AVAssetDownloadURLSession
    const existing = (
      c.modResults.BGTaskSchedulerPermittedIdentifiers ?? []
    ) as string[];

    if (!existing.includes('com.fcdownloader.hls-download')) {
      c.modResults.BGTaskSchedulerPermittedIdentifiers = [
        ...existing,
        'com.fcdownloader.hls-download',
      ];
    }

    return c;
  });
};

export default withBackgroundAssetDownload;

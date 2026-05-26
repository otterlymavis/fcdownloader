/**
 * aria2c Transport Layer — optional reliability improvement for large direct
 * downloads on Android. NOT a replacement for any existing downloader.
 *
 * Architecture:
 *   DownloadEngine
 *   ├── NativeDownloader      (existing directDownloader.ts)
 *   ├── HLSDownloader         (existing hlsDownloader.ts)
 *   ├── DASHDownloader        (existing dashDownloader.ts)
 *   ├── ytDlpDownloader       (existing youtubeDownloader.ts)
 *   ├── AndroidAria2Transport ← this file (Android only)
 *   ├── IOSNativeTransport    ← this file (iOS — thin wrapper, no binary)
 *   └── DesktopAria2Transport ← this file (future desktop)
 *
 * aria2c is ONLY used for:
 *   - large single-file (direct) MP4/WebM downloads
 *   - resumable downloads on unstable networks
 *   - segmented HTTP transfers
 *
 * aria2c is NEVER used for:
 *   - HLS manifest + segment assembly (hlsDownloader.ts handles this)
 *   - DASH stream muxing (dashDownloader.ts handles this)
 *   - extraction logic (platformExtractors / serverExtractor handle this)
 *   - auth/session handling (extraction layer owns headers/cookies)
 *
 * Feature flags: USE_ARIA2_ANDROID, USE_ARIA2_FALLBACK (see featureFlags.ts)
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { DetectedMedia } from '../types';
import { USE_ARIA2_ANDROID, USE_ARIA2_FALLBACK } from './featureFlags';
import { DownloadOptions } from './hlsDownloader';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TransportOptions {
  /** Destination file path (absolute). */
  destPath: string;
  /** HTTP headers to forward verbatim (User-Agent, Referer, Cookie, etc.). */
  headers?: Record<string, string>;
  /** AbortController signal for cancellation. */
  signal?: AbortSignal;
  /** Progress callback (0–1). */
  onProgress?: (progress: number) => void;
  /** Number of parallel connections (aria2c -x). Default: 4 */
  connections?: number;
  /** Number of splits per file (aria2c -s). Default: same as connections */
  splits?: number;
}

export interface TransportResult {
  /** Path to the downloaded file. */
  filePath: string;
  /** Which transport was used. */
  transport: 'aria2-android' | 'ios-native' | 'expo-fs' | 'aria2-rpc';
  /** File size in bytes if known. */
  fileSize?: number;
}

// ── Eligibility check ─────────────────────────────────────────────────────────

/**
 * Returns true when aria2c transport is eligible for a given media item.
 *
 * Eligible = direct single-file download (not HLS/DASH) on a supported platform.
 * HLS and DASH are ALWAYS handled by their dedicated downloaders.
 */
export function isAria2Eligible(media: DetectedMedia): boolean {
  if (!USE_ARIA2_ANDROID && !USE_ARIA2_FALLBACK) return false;
  // Never intercept HLS or DASH — those have dedicated assemblers
  if (media.mediaType === 'hls' || media.mediaType === 'dash') return false;
  // Must be a direct file
  if (media.mediaType !== 'direct') return false;
  // Platform check
  if (Platform.OS === 'ios') return false; // iOS uses NSURLSession
  if (Platform.OS === 'android') return USE_ARIA2_ANDROID;
  return false;
}

// ── Android aria2c RPC transport ─────────────────────────────────────────────

/**
 * AndroidAria2Transport
 *
 * Uses the bundled aria2c binary (in jniLibs/) via a native module RPC bridge.
 * Falls back to expo-file-system if the native module is unavailable.
 *
 * Binary placement:
 *   android/app/src/main/jniLibs/
 *   ├── arm64-v8a/libaria2c.so    (symlink to aria2c binary, renamed .so)
 *   ├── armeabi-v7a/libaria2c.so
 *   └── x86_64/libaria2c.so
 *
 * The native module (FcAria2Module.kt) exposes:
 *   FcAria2.startRpc()         → starts aria2c --enable-rpc --rpc-listen-port=6800
 *   FcAria2.addUri(opts)       → RPC addUri call, returns GID
 *   FcAria2.getStatus(gid)     → tellStatus
 *   FcAria2.removeDownload(gid) → remove + removeDownloadResult
 *   FcAria2.stopRpc()          → kills the aria2c process
 */
async function downloadViaAndroidAria2(
  url: string,
  opts: TransportOptions,
): Promise<TransportResult> {
  // Try to import the native module. If unavailable (simulator, binary not
  // bundled, etc.) we fall through to expo-fs immediately.
  let FcAria2: any;
  try {
    // NativeModules is available in RN; this import path may vary per project setup.
    const { NativeModules } = await import('react-native');
    FcAria2 = NativeModules.FcAria2;
  } catch {
    FcAria2 = null;
  }

  if (!FcAria2) {
    console.warn('[aria2Transport] FcAria2 native module not available; falling back to expo-fs');
    return downloadViaExpoFs(url, opts);
  }

  console.log('[aria2Transport] Android aria2c RPC download:', url);

  let gid: string | null = null;
  try {
    // Start aria2c RPC daemon if not already running
    await FcAria2.startRpc();

    // Build header array for aria2c RPC (format: "Header: Value")
    const headerList: string[] = [];
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) {
        if (k && v) headerList.push(`${k}: ${v}`);
      }
    }

    gid = await FcAria2.addUri({
      uri: url,
      dir: opts.destPath.substring(0, opts.destPath.lastIndexOf('/')),
      out: opts.destPath.substring(opts.destPath.lastIndexOf('/') + 1),
      connections: opts.connections ?? 4,
      splits: opts.splits ?? (opts.connections ?? 4),
      headers: headerList,
    });

    // Poll for completion
    let done = false;
    while (!done) {
      if (opts.signal?.aborted) {
        if (gid) await FcAria2.removeDownload(gid).catch(() => {});
        throw new Error('Download cancelled');
      }

      await new Promise(r => setTimeout(r, 500));
      const status = await FcAria2.getStatus(gid);

      if (status.status === 'complete') {
        done = true;
        const fileSize = parseInt(status.totalLength ?? '0', 10);
        opts.onProgress?.(1);
        return { filePath: opts.destPath, transport: 'aria2-android', fileSize };
      } else if (status.status === 'error') {
        throw new Error(`aria2c error: ${status.errorMessage ?? 'unknown'}`);
      } else if (status.status === 'removed') {
        throw new Error('aria2c download was removed externally');
      }

      // Progress (0–1)
      const total = parseInt(status.totalLength ?? '0', 10);
      const downloaded = parseInt(status.completedLength ?? '0', 10);
      if (total > 0) opts.onProgress?.(downloaded / total);
    }

    return { filePath: opts.destPath, transport: 'aria2-android' };
  } catch (e) {
    if (gid) {
      try { await FcAria2.removeDownload(gid); } catch {}
    }
    throw e;
  }
}

// ── iOS native transport ──────────────────────────────────────────────────────

/**
 * IOSNativeTransport
 *
 * iOS does not support arbitrary binary execution. We use expo-file-system's
 * createDownloadResumable which is backed by NSURLSession under the hood.
 * This provides:
 *   - Background download support
 *   - Automatic resume on network change
 *   - System-level progress reporting
 *
 * The aria2-style segmented approach is NOT implemented here because iOS
 * NSURLSession handles range requests and connection reuse internally.
 */
async function downloadViaIosNative(
  url: string,
  opts: TransportOptions,
): Promise<TransportResult> {
  console.log('[aria2Transport] iOS NSURLSession download:', url);

  const resumable = FileSystem.createDownloadResumable(
    url,
    opts.destPath,
    { headers: opts.headers ?? {} },
    (progress) => {
      const { totalBytesWritten, totalBytesExpectedToWrite } = progress;
      if (totalBytesExpectedToWrite > 0) {
        opts.onProgress?.(totalBytesWritten / totalBytesExpectedToWrite);
      }
    },
  );

  if (opts.signal) {
    opts.signal.addEventListener('abort', () => {
      resumable.pauseAsync().catch(() => {});
    });
  }

  const result = await resumable.downloadAsync();
  if (!result) throw new Error('iOS download returned null result');

  opts.onProgress?.(1);
  return {
    filePath: result.uri,
    transport: 'ios-native',
    fileSize: undefined, // expo-fs doesn't expose size on result
  };
}

// ── Expo FileSystem fallback ──────────────────────────────────────────────────

async function downloadViaExpoFs(
  url: string,
  opts: TransportOptions,
): Promise<TransportResult> {
  console.log('[aria2Transport] expo-fs download (fallback):', url);

  const download = FileSystem.createDownloadResumable(
    url,
    opts.destPath,
    { headers: opts.headers ?? {} },
    (progress) => {
      const { totalBytesWritten, totalBytesExpectedToWrite } = progress;
      if (totalBytesExpectedToWrite > 0) {
        opts.onProgress?.(totalBytesWritten / totalBytesExpectedToWrite);
      }
    },
  );

  if (opts.signal) {
    opts.signal.addEventListener('abort', () => {
      download.pauseAsync().catch(() => {});
    });
  }

  const result = await download.downloadAsync();
  if (!result) throw new Error('expo-fs download returned null');

  opts.onProgress?.(1);
  return { filePath: result.uri, transport: 'expo-fs' };
}

// ── Public transport selector ─────────────────────────────────────────────────

/**
 * Download a single direct file using the best available transport.
 *
 * Transport selection order:
 *   Android + USE_ARIA2_ANDROID → AndroidAria2Transport → expo-fs fallback
 *   iOS                         → IOSNativeTransport
 *   Other                       → expo-fs
 *
 * All auth headers (Referer, Cookie, User-Agent) extracted by the extraction
 * layer are passed through verbatim — this function never modifies them.
 */
export async function downloadWithBestTransport(
  url: string,
  opts: TransportOptions,
): Promise<TransportResult> {
  // Preserve all headers exactly as extracted — never strip or modify
  const headers = opts.headers ?? {};

  if (Platform.OS === 'ios') {
    return downloadViaIosNative(url, { ...opts, headers });
  }

  if (Platform.OS === 'android' && USE_ARIA2_ANDROID) {
    try {
      return await downloadViaAndroidAria2(url, { ...opts, headers });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      console.warn('[aria2Transport] Android aria2c failed, falling back to expo-fs:', String(e).slice(0, 200));
      if (!USE_ARIA2_FALLBACK) throw e;
      return downloadViaExpoFs(url, { ...opts, headers });
    }
  }

  return downloadViaExpoFs(url, { ...opts, headers });
}

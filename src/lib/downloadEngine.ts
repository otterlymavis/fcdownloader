/**
 * DownloadEngine — unified download orchestrator.
 *
 * Architecture:
 *
 *   DownloadEngine
 *   ├── NativeDownloader      → directDownloader.ts   (small files, images, audio)
 *   ├── HLSDownloader         → hlsDownloader.ts       (HLS segment assembly)
 *   ├── DASHDownloader        → dashDownloader.ts      (DASH + FFmpeg mux)
 *   ├── ytDlpDownloader       → youtubeDownloader.ts   (yt-dlp on Android)
 *   ├── VimeoDownloader       → vimeoJsonDownloader.ts (Vimeo JSON playlist)
 *   ├── ServerDownloader      → serverDownloader.ts    (server-side yt-dlp)
 *   ├── AndroidAria2Transport → aria2Transport.ts      (large direct, Android)
 *   └── IOSNativeTransport    → aria2Transport.ts      (large direct, iOS)
 *
 * Responsibilities:
 *  - Route media items to the correct downloader based on strategy + site caps
 *  - Apply aria2c transport for eligible large direct downloads
 *  - Emit diagnostics (downloader selected, fallbacks, retries)
 *  - Never modify extraction context (headers, cookies, auth) — pass through verbatim
 *
 * What this is NOT:
 *  - An extraction engine (platformExtractors / serverExtractor own that)
 *  - A manifest resolver (HLS/DASH downloaders own that)
 *  - A YouTube bypass (ytExtractor / youtubeDownloader own that)
 */

import { DetectedMedia, DownloadStrategy } from '../types';
import { DownloadOptions, ProgressCallback } from './hlsDownloader';
import { runDownload, pickStrategy } from './downloadStrategies';
import { isAria2Eligible, downloadWithBestTransport, TransportOptions } from './aria2Transport';
import { USE_ARIA2_ANDROID, USE_ARIA2_FALLBACK } from './featureFlags';
import { getSiteCapabilities } from './siteRegistry';
import * as FileSystem from 'expo-file-system/legacy';

// ── Diagnostics ───────────────────────────────────────────────────────────────

function logDownloaderSelected(strategy: DownloadStrategy, media: DetectedMedia) {
  console.log(
    `[DownloadEngine] strategy=${strategy} url=${media.url.slice(0, 80)} aria2Eligible=${isAria2Eligible(media)}`,
  );
}

function logFallback(from: string, to: string, reason: string) {
  console.warn(`[DownloadEngine] fallback ${from} → ${to}: ${reason}`);
}

function logAria2Activation(url: string) {
  console.log(`[DownloadEngine] aria2c transport activated for: ${url.slice(0, 80)}`);
}

function logAria2Fallback(reason: string) {
  console.warn(`[DownloadEngine] aria2c failed, using native: ${reason}`);
}

// ── Large-file threshold ──────────────────────────────────────────────────────

/** Minimum file size (bytes) to consider aria2c for segmented download. */
const ARIA2_MIN_BYTES = 10 * 1024 * 1024; // 10 MB

/** Returns true when content-length suggests this is a large download. */
async function isLargeFile(url: string, headers?: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: headers ?? {} });
    const cl = res.headers.get('content-length');
    if (cl) return parseInt(cl, 10) >= ARIA2_MIN_BYTES;
  } catch {}
  return false; // unknown size → don't force aria2c
}

// ── DownloadEngine ────────────────────────────────────────────────────────────

export class DownloadEngine {
  /**
   * Download a media item using the best available downloader + transport.
   *
   * Strategy selection order:
   *   1. Use site registry preferred strategies when available.
   *   2. Fall back to pickStrategy() (manifest-type-based).
   *   3. For direct downloads on Android: aria2c transport when eligible.
   *   4. On failure: fall back to standard runDownload() chain.
   */
  async download(
    media: DetectedMedia,
    taskId: string,
    opts: DownloadOptions = {},
  ): Promise<string> {
    // Determine strategy — site registry hints take priority
    const caps = getSiteCapabilities(media.pageUrl);
    let strategy: DownloadStrategy;
    if (caps?.preferredStrategies.length) {
      strategy = caps.preferredStrategies[0];
    } else {
      strategy = pickStrategy(media);
    }

    logDownloaderSelected(strategy, media);

    // ── aria2c transport path (Android, direct downloads only) ────────────
    // aria2c is ONLY eligible for direct single-file downloads — never for
    // HLS/DASH (those have their own assemblers), never for server-download.
    if (
      strategy === 'direct' &&
      isAria2Eligible(media) &&
      (USE_ARIA2_ANDROID || USE_ARIA2_FALLBACK)
    ) {
      try {
        // Only use aria2c for large files; small downloads don't benefit
        const large = await isLargeFile(media.url, media.httpHeaders);
        if (large) {
          logAria2Activation(media.url);
          const destPath = `${FileSystem.documentDirectory ?? ''}fcdownloader/${taskId}.mp4`;
          // Convert ProgressCallback (done, total) → (0-1) float for transport
          const progressAdapter = opts.onProgress
            ? (p: number) => opts.onProgress!(Math.round(p * 100), 100)
            : undefined;
          const result = await downloadWithBestTransport(media.url, {
            destPath,
            headers: media.httpHeaders,
            signal: opts.signal,
            onProgress: progressAdapter,
            connections: 4,
            splits: 4,
          });
          console.log(`[DownloadEngine] aria2c complete: ${result.filePath} via ${result.transport}`);
          opts.onStatus?.('completed');
          return result.filePath;
        }
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        logAria2Fallback(String(e).slice(0, 200));
        // Fall through to standard runDownload() below
      }
    }

    // ── Standard downloader chain ─────────────────────────────────────────
    // runDownload() already implements non-fatal fallback:
    //   strategy → server-download → throw
    // All existing downloaders (HLS, DASH, Vimeo, yt-dlp, direct) are used
    // exactly as before.
    return runDownload(media, taskId, strategy, opts);
  }

  /**
   * Download with an explicit strategy (bypasses site registry hints).
   * Used by callers that have already resolved the strategy (e.g. the format
   * picker in the UI).
   */
  async downloadWithStrategy(
    media: DetectedMedia,
    taskId: string,
    strategy: DownloadStrategy,
    opts: DownloadOptions = {},
  ): Promise<string> {
    logDownloaderSelected(strategy, media);
    return runDownload(media, taskId, strategy, opts);
  }
}

/** Shared singleton — import this instead of constructing a new instance. */
export const downloadEngine = new DownloadEngine();

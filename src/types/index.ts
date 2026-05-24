export type MediaType = 'hls' | 'dash' | 'direct' | 'mse';
export type MediaKind = 'video' | 'image' | 'audio';

export type DownloadStatus =
  | 'pending'
  | 'fetching_manifest'
  | 'downloading'
  | 'assembling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type DownloadStrategy = 'hls-segments' | 'direct' | 'dash' | 'vimeo-json' | 'ffmpeg' | 'yt-dlp';

export type ManifestType = 'hls' | 'dash' | 'direct' | 'mse' | 'vimeo-json';

/** Where the URL was first observed. Ordered from highest to lowest signal strength. */
export type Provenance =
  | 'yt-player-response'    // ytInitialPlayerResponse.streamingData (strongest signal)
  | 'player-sdk-hook'       // hls.js / Shaka / JW Player API intercepted
  | 'media-element'         // HTMLMediaElement.src setter (blob resolved or direct)
  | 'mediasource'           // MediaSource.addSourceBuffer (codec detection)
  | 'append-buffer'         // SourceBuffer.appendBuffer (active playback confirmation)
  | 'fetch-hook'            // window.fetch intercepted
  | 'xhr-hook'              // XMLHttpRequest intercepted
  | 'perf-observer'         // PerformanceObserver resource timing
  | 'page-global'           // __NEXT_DATA__, __playinfo__, TikTok globals, etc.
  | 'mutation-observer'     // dynamically added <video>/<source> element
  | 'social-extractor'      // server-side platformExtractors.ts fetch
  | 'manifest-parser'       // content-based: #EXTM3U or <MPD detected in response body
  | 'manual';               // user typed/pasted the URL

/** Unified schema for all detected media streams. */
export interface StreamVariant {
  id: string;
  url: string;
  manifestType: ManifestType;
  container?: string;       // mp4 | webm | ts | fmp4
  codecs?: string;          // e.g. "avc1.640028,mp4a.40.2"
  bitrate?: number;         // bits/sec
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  hasVideo: boolean;
  duration?: number;        // seconds
  provenance: Provenance;
  confidence: number;       // 0–1
  segmentStrategy?: DownloadStrategy;
  audioTrackUrl?: string;   // separate audio track URL (Bilibili DASH, etc.)
  audioTrackCodecs?: string;
  label?: string;
  platform?: string;
  pageUrl?: string;
  userAgent?: string;
  mimeType?: string;
  timestamp?: number;
}

export interface DetectedMedia {
  id: string;
  url: string;
  pageUrl: string;
  userAgent: string;
  timestamp: number;
  mimeType?: string;
  mediaType: MediaType;
  mediaKind?: MediaKind;
  label?: string;
  confidence?: number;         // 0–1
  provenance?: Provenance;
  audioTrackUrl?: string;      // separate audio track (Bilibili DASH, paired downloads)
  audioTrackCodecs?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  codecs?: string;
  hasAudio?: boolean;
  hasVideo?: boolean;
  /** Exact HTTP headers to replay for all download requests (set by extractors). When present, downloaders must use these verbatim instead of building their own. */
  httpHeaders?: Record<string, string>;
}

export interface DownloadTask {
  id: string;
  media: DetectedMedia;
  strategy: DownloadStrategy;
  status: DownloadStatus;
  progress: number;
  totalSegments: number;
  downloadedSegments: number;
  localPlaylistPath?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

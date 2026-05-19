export type MediaType = 'hls' | 'dash';

export type DownloadStatus =
  | 'pending'
  | 'fetching_manifest'
  | 'downloading'
  | 'assembling'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * hls-segments — fetches manifest, downloads every .ts/.m4s, builds local playlist
 * direct       — single HTTP GET to disk (MP4, WebM, any direct file URL)
 * ffmpeg       — ffmpeg-kit mux to MP4; handles DASH + complex auth (requires extra native dep)
 */
export type DownloadStrategy = 'hls-segments' | 'direct' | 'vimeo-json' | 'ffmpeg';

export interface DetectedMedia {
  id: string;
  url: string;
  pageUrl: string;
  userAgent: string;
  timestamp: number;
  mimeType?: string;
  mediaType: MediaType;
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

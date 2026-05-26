/**
 * Feature flags for the fcdownloader app.
 *
 * All flags default to safe/conservative values. Set them via your build
 * environment (EXPO_PUBLIC_* vars) or AsyncStorage overrides in dev builds.
 *
 * Flags MUST NOT affect extraction logic — they only control transport and
 * download engine behaviour. Extraction (platform extractors, server extraction,
 * yt-dlp) is always active and unaffected by these flags.
 */

import Constants from 'expo-constants';

const _extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;

function boolFlag(key: string, envKey: string, defaultValue: boolean): boolean {
  // 1. Build-time expo extra (set via EXPO_PUBLIC_* in .env.local → app.config.ts)
  if (typeof _extra[key] === 'boolean') return _extra[key] as boolean;
  if (typeof _extra[key] === 'string') return _extra[key] === 'true';
  return defaultValue;
}

/** ── Download transport flags ──────────────────────────────────────────────── */

/**
 * USE_ARIA2_ANDROID
 * Enable the aria2c RPC transport for large direct MP4 downloads on Android.
 * When true, the AndroidAria2Transport is used for eligible direct downloads.
 * aria2c binary must be present in jniLibs/; falls back to native if missing.
 */
export const USE_ARIA2_ANDROID = boolFlag('useAria2Android', 'EXPO_PUBLIC_USE_ARIA2_ANDROID', false);

/**
 * USE_ARIA2_FALLBACK
 * Allow aria2c as a fallback when the primary downloader fails for direct downloads.
 * Only applies to large single-file transfers (not HLS/DASH streams).
 */
export const USE_ARIA2_FALLBACK = boolFlag('useAria2Fallback', 'EXPO_PUBLIC_USE_ARIA2_FALLBACK', false);

/**
 * USE_NATIVE_IOS_TRANSPORT
 * Use NSURLSession / AVFoundation-based native downloader on iOS (always on).
 * This flag exists so the DownloadEngine can query the transport without
 * platform-checking — it is always true on iOS and false elsewhere.
 */
export const USE_NATIVE_IOS_TRANSPORT = boolFlag('useNativeIosTransport', 'EXPO_PUBLIC_USE_NATIVE_IOS_TRANSPORT', true);

/** ── Architecture flags ─────────────────────────────────────────────────────── */

/**
 * USE_NEW_EXTRACTION_MANAGER
 * Route paste-URL extraction through ExtractionManager instead of calling
 * extractFromSocialUrl directly. ExtractionManager is a thin wrapper with
 * diagnostics — enabling this should be transparent to users.
 */
export const USE_NEW_EXTRACTION_MANAGER = boolFlag('useNewExtractionManager', 'EXPO_PUBLIC_USE_NEW_EXTRACTION_MANAGER', true);

/**
 * USE_YTDLP_BACKEND
 * Attempt server-assisted yt-dlp extraction before on-device extractors.
 * Disabling this makes the app fully local — useful for testing on-device paths.
 */
export const USE_YTDLP_BACKEND = boolFlag('useYtdlpBackend', 'EXPO_PUBLIC_USE_YTDLP_BACKEND', true);

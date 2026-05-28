/**
 * ExtractionManager — orchestrates all extraction strategies with:
 *  - Non-fatal fallback pipeline (a single extractor failure never aborts)
 *  - Structured ExtractionResult type for per-attempt diagnostics
 *  - Site capability registry integration for smart strategy ordering
 *  - Extraction diagnostics logging
 *
 * This is a thin orchestration layer on top of the existing
 * `extractFromSocialUrl` pipeline in platformExtractors.ts. It does NOT
 * rewrite or replace any existing extractor — it wraps them and adds
 * observability + strategy hints.
 */
import { DetectedMedia, DownloadStrategy } from '../types';
import { extractFromSocialUrl, isSocialPageUrl } from './platformExtractors';
import { extractViaServer } from './serverExtractor';
import { getSiteCapabilities } from './siteRegistry';
import { pickStrategy } from './downloadStrategies';
import { debugLog, debugWarn } from './releaseLogger';

// ── Result types ─────────────────────────────────────────────────────────────

export interface ExtractionResult {
  /** Extraction succeeded and produced at least one media item. */
  success: boolean;
  /**
   * Fatal = true means the failure is definitive and no downstream fallback
   * should be attempted (e.g. DRM, region block, authentication required with
   * no session). Fatal = false means the caller MUST try the next strategy.
   */
  fatal: boolean;
  /** Which extraction strategy produced this result. */
  strategy: string;
  /** Confidence 0–1 in the extracted URLs (from the individual media items). */
  confidence: number;
  /** Human-readable failure reason when success = false. */
  reason?: string;
  /** Extracted media items when success = true. */
  media?: DetectedMedia[];
  /** Per-attempt diagnostics (name → reason). Populated on full failure. */
  diagnostics?: Record<string, string>;
}

// ── Capability scoring ────────────────────────────────────────────────────────

/**
 * Score an extracted media item by media kind and type.
 * Higher = better quality / more complete.
 *
 * Priority ladder (highest first):
 *   authenticated HD adaptive (paired dash with audio track) → 5
 *   HLS manifest                                             → 4
 *   direct MP4/WebM (single file)                           → 3
 *   OG/meta extracted                                        → 2
 *   runtime capture / unknown                                → 1
 */
export function scoreMedia(media: DetectedMedia): number {
  if (media.mediaKind === 'image' || media.mediaKind === 'audio') return 3;
  if (media.audioTrackUrl) return 5; // paired DASH → needs mux, but is HD
  if (media.mediaType === 'hls') return 4;
  if (media.mediaType === 'dash') return 4;
  if (media.mediaType === 'direct') return 3;
  if (media.provenance === 'social-extractor' && !media.mediaType) return 2;
  return 1;
}

/**
 * Pick the "best" item from a list by score then confidence.
 * The full list is still returned — this just surfaces the best candidate.
 */
export function pickBestMedia(items: DetectedMedia[]): DetectedMedia | undefined {
  if (items.length === 0) return undefined;
  return [...items].sort((a, b) => {
    const scoreDiff = scoreMedia(b) - scoreMedia(a);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  })[0];
}

// ── Attempt runner ────────────────────────────────────────────────────────────

async function runAttempt(
  name: string,
  fn: () => Promise<DetectedMedia[]>,
): Promise<{ success: boolean; media?: DetectedMedia[]; reason?: string }> {
  try {
    const media = await fn();
    if (media.length > 0) return { success: true, media };
    return { success: false, reason: 'no media returned' };
  } catch (e) {
    return { success: false, reason: String((e as Error)?.message ?? e).slice(0, 240) };
  }
}

// ── ExtractionManager ─────────────────────────────────────────────────────────

export class ExtractionManager {
  /**
   * Extract media from a URL using the full non-fatal fallback pipeline.
   *
   * Behaviour:
   *  1. Consults the site registry for preferred strategies.
   *  2. Runs server-assisted extraction first when a server is configured.
   *  3. Falls through to platform-specific on-device extractors.
   *  4. Collects diagnostics for every attempt.
   *  5. Never throws — failures are encoded in the returned ExtractionResult.
   */
  async extract(pageUrl: string): Promise<ExtractionResult> {
    const caps = getSiteCapabilities(pageUrl);
    const diagnostics: Record<string, string> = {};

    // ── Tier 1: server-assisted (yt-dlp backend) ──────────────────────────
    // Always try first when a backend is configured; it handles authenticated
    // HD, Japanese sites, DRM-lite scenarios, and everything yt-dlp supports.
    {
      const attempt = await runAttempt('server-extraction', () => extractViaServer(pageUrl));
      if (attempt.success && attempt.media) {
        debugLog('[ExtractionManager] success via server-extraction for', pageUrl);
        return {
          success: true,
          fatal: false,
          strategy: 'server-extraction',
          confidence: Math.max(...attempt.media.map(m => m.confidence ?? 0.9)),
          media: attempt.media,
        };
      }
      diagnostics['server-extraction'] = attempt.reason ?? 'no media';
      debugLog('[ExtractionManager] server-extraction failed:', attempt.reason);
    }

    // ── Tier 2: platform-specific + HTML detection pipeline ───────────────
    // `extractFromSocialUrl` already has a full non-fatal fallback chain:
    // platform extractor → HLS detector → DASH detector → OG/meta → generic.
    // We delegate to it and report the aggregate result.
    if (isSocialPageUrl(pageUrl) || caps) {
      const attempt = await runAttempt('platform-extractors', () => extractFromSocialUrl(pageUrl));
      if (attempt.success && attempt.media) {
        const best = pickBestMedia(attempt.media);
        debugLog('[ExtractionManager] success via platform-extractors, best:', best?.mediaType, best?.label);
        return {
          success: true,
          fatal: false,
          strategy: 'platform-extractors',
          confidence: best?.confidence ?? 0.8,
          media: attempt.media,
        };
      }
      diagnostics['platform-extractors'] = attempt.reason ?? 'no media';
    }

    // ── Tier 3: generic fallback — try extractFromSocialUrl even for unknown
    //    URLs (it has a generic HTML media detector chain as last resort).
    if (!isSocialPageUrl(pageUrl) && !caps) {
      const attempt = await runAttempt('generic-html-detection', () => extractFromSocialUrl(pageUrl));
      if (attempt.success && attempt.media) {
        const best = pickBestMedia(attempt.media);
        return {
          success: true,
          fatal: false,
          strategy: 'generic-html-detection',
          confidence: best?.confidence ?? 0.5,
          media: attempt.media,
        };
      }
      diagnostics['generic-html-detection'] = attempt.reason ?? 'no media';
    }

    // ── All tiers failed ──────────────────────────────────────────────────
    const summary = Object.entries(diagnostics)
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ');
    debugWarn('[ExtractionManager] all extraction tiers failed for', pageUrl, '—', summary);
    return {
      success: false,
      fatal: false,
      strategy: 'none',
      confidence: 0,
      reason: summary || 'all extraction strategies failed',
      diagnostics,
    };
  }

  /**
   * Convenience: extract and return just the media list (empty on failure).
   * This is a drop-in replacement for callers that used extractFromSocialUrl
   * directly but want the improved fallback + diagnostics.
   */
  async extractMedia(pageUrl: string): Promise<DetectedMedia[]> {
    const result = await this.extract(pageUrl);
    return result.media ?? [];
  }

  /**
   * Derive the recommended download strategy for a detected media item using
   * the site registry preferences when available, falling back to the
   * manifest-type-based pickStrategy().
   */
  recommendStrategy(media: DetectedMedia): DownloadStrategy {
    const caps = getSiteCapabilities(media.pageUrl);
    if (caps?.preferredStrategies.length) {
      // Return the highest-priority registered strategy that pickStrategy also
      // agrees with (or the first if they disagree — registry wins for these sites).
      return caps.preferredStrategies[0];
    }
    return pickStrategy(media);
  }
}

/** Shared singleton — import this instead of constructing a new instance. */
export const extractionManager = new ExtractionManager();

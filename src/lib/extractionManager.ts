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
import { DetectedMedia, DownloadStrategy, SourceAuditEntry } from '../types';
import { extractFromSocialUrl, isSocialPageUrl } from './platformExtractors';
import { extractViaServer, ServerExtractionError, ServerExtractOptions } from './serverExtractor';
import { ClientExtractionStrategy, getSiteCapabilities } from './siteRegistry';
import { pickStrategy } from './downloadStrategies';
import { debugLog, debugWarn } from './releaseLogger';
import { autoDownloadableUniversalMedia, probeUniversalMediaFromSession, probeUniversalMediaFromUrl } from './universalMediaProbe';
import { extractUniversalEmbedUrls, extractUniversalOEmbedUrls } from './universalEmbedProbe';

const VIMEO_JSON_URL_RE = /(?:vimeocdn\.com\/.*\/playlist\.json|player\.vimeo\.com\/video\/\d+\/config\/?)(?:[?#]|$)/i;

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
  /** Machine-readable error code from the server (AUTH_REQUIRED, GEO_BLOCKED, etc.)
   *  when the server was the reason all strategies failed. */
  errorCode?: string;
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
): Promise<{ success: boolean; media?: DetectedMedia[]; reason?: string; errorCode?: string }> {
  try {
    const media = await fn();
    if (media.length > 0) return { success: true, media };
    return { success: false, reason: 'no media returned' };
  } catch (e) {
    const errorCode = e instanceof ServerExtractionError ? e.code : undefined;
    return { success: false, reason: String((e as Error)?.message ?? e).slice(0, 240), errorCode };
  }
}

// ── ExtractionManager ─────────────────────────────────────────────────────────

export interface ExtractionManagerDeps {
  extractViaServer: typeof extractViaServer;
  extractFromSocialUrl: typeof extractFromSocialUrl;
  probeUniversalMediaFromUrl: typeof probeUniversalMediaFromUrl;
  probeUniversalMediaFromSession: typeof probeUniversalMediaFromSession;
  extractUniversalEmbedUrls: typeof extractUniversalEmbedUrls;
  extractUniversalOEmbedUrls: typeof extractUniversalOEmbedUrls;
}

const DEFAULT_DEPS: ExtractionManagerDeps = {
  extractViaServer,
  extractFromSocialUrl,
  probeUniversalMediaFromUrl,
  probeUniversalMediaFromSession,
  extractUniversalEmbedUrls,
  extractUniversalOEmbedUrls,
};

function appendSourceAudit(items: DetectedMedia[], audit: SourceAuditEntry): DetectedMedia[] {
  return items.map((item) => ({
    ...item,
    sourceAudit: [...(item.sourceAudit ?? []), audit],
  }));
}

export class ExtractionManager {
  constructor(private readonly deps: ExtractionManagerDeps = DEFAULT_DEPS) {}

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
  async extract(pageUrl: string, session?: ServerExtractOptions): Promise<ExtractionResult> {
    const caps = getSiteCapabilities(pageUrl);
    const diagnostics: Record<string, string> = {};
    let serverErrorCode: string | undefined;
    let browserProbeMedia: DetectedMedia[] | undefined;
    const orderedTiersRun = new Set<ClientExtractionStrategy>();

    const hasVimeoSignal =
      /(?:^|\/\/)(?:www\.)?vimeo\.com\/|player\.vimeo\.com\/video\/|vimeocdn\.com\/.*\/playlist\.json/i.test(pageUrl) ||
      /player\.vimeo\.com\/video\/|vimeocdn\.com\/.*\/playlist\.json|data-vimeo-(?:id|url)\b|Vimeo\.Player\b/i.test(session?.pageHtml ?? '') ||
      (session?.mediaHints ?? []).some((hint) => {
        const url = String(hint.url ?? hint.src ?? '');
        return /player\.vimeo\.com\/video\/|vimeocdn\.com\/.*\/playlist\.json/i.test(url);
      });

    // Vimeo player config is already a complete, downloadable source descriptor.
    // Prefer it before the server tier so embedded players do not wait for a
    // remote extractor or surface their individual AV fragments.
    if (hasVimeoSignal) {
      browserProbeMedia = this.deps.probeUniversalMediaFromSession({
        pageUrl,
        pageHtml: session?.pageHtml ?? undefined,
        mediaHints: session?.mediaHints ?? undefined,
      });
      const vimeoJson = browserProbeMedia.filter((item) => VIMEO_JSON_URL_RE.test(item.url));
      if (vimeoJson.length > 0) {
        const best = pickBestMedia(vimeoJson);
        return {
          success: true,
          fatal: false,
          strategy: 'universal-browser-probe',
          confidence: best?.confidence ?? 0.95,
          media: vimeoJson,
        };
      }
    }

    const tryBrowserEmbedTier = async (): Promise<ExtractionResult | undefined> => {
      if (!session?.pageHtml) return undefined;

      const attemptedEmbedUrls = new Set<string>();
      const embedFailures: string[] = [];
      const tryEmbedCandidates = async (embeds: ReturnType<typeof extractUniversalEmbedUrls>): Promise<ExtractionResult | undefined> => {
        for (const embed of embeds.slice(0, 5)) {
          if (attemptedEmbedUrls.has(embed.url)) continue;
          attemptedEmbedUrls.add(embed.url);
          const audit: SourceAuditEntry = {
            strategy: 'browser-embedded-player',
            source: embed.source,
            url: embed.url,
            selected: true,
            fieldPath: embed.fieldPath,
          };
          const embedSession: ServerExtractOptions = {
            ...session,
            referer: session.referer ?? pageUrl,
            pageHtml: null,
            mediaHints: null,
            sourceAudit: [...(session.sourceAudit ?? []), audit],
          };

          const serverAttempt = await runAttempt('browser-embed-server', () => this.deps.extractViaServer(embed.url, embedSession));
          if (serverAttempt.success && serverAttempt.media) {
            const media = appendSourceAudit(serverAttempt.media, audit);
            const best = pickBestMedia(media);
            debugLog('[ExtractionManager] success via browser embed server for', embed.url);
            return {
              success: true,
              fatal: false,
              strategy: 'browser-embed-server',
              confidence: best?.confidence ?? 0.82,
              media,
            };
          }
          embedFailures.push(`${embed.url}: server ${serverAttempt.reason ?? 'no media'}`);

          const platformAttempt = await runAttempt('browser-embed-platform', () => this.deps.extractFromSocialUrl(embed.url, { skipServer: true }));
          if (platformAttempt.success && platformAttempt.media) {
            const media = appendSourceAudit(platformAttempt.media, audit);
            const best = pickBestMedia(media);
            debugLog('[ExtractionManager] success via browser embed platform for', embed.url);
            return {
              success: true,
              fatal: false,
              strategy: 'browser-embed-platform',
              confidence: best?.confidence ?? 0.78,
              media,
            };
          }
          embedFailures.push(`${embed.url}: platform ${platformAttempt.reason ?? 'no media'}`);
        }
        return undefined;
      };

      const embeds = this.deps.extractUniversalEmbedUrls(pageUrl, session.pageHtml);
      const embedResult = await tryEmbedCandidates(embeds);
      if (embedResult) return embedResult;

      let oEmbeds: ReturnType<typeof extractUniversalEmbedUrls> = [];
      try {
        oEmbeds = await this.deps.extractUniversalOEmbedUrls(pageUrl, session.pageHtml ?? undefined);
      } catch (e) {
        embedFailures.push(`oEmbed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      }
      const oEmbedResult = await tryEmbedCandidates(oEmbeds);
      if (oEmbedResult) return oEmbedResult;
      if (oEmbeds.length === 0) embedFailures.push('oEmbed: no embeds');

      if (embeds.length > 0 || oEmbeds.length > 0 || embedFailures.length > 0) {
        diagnostics['browser-embed-extraction'] = embedFailures.join('; ').slice(0, 400) || 'no media';
      }
      return undefined;
    };

    // ── Configured extraction order ────────────────────────────────────────────
    // When a site registry entry declares an explicit extractionOrder, run those
    // tiers first in that order before falling through to the default pipeline.
    // Tiers not in the list still run afterward as fallback — no coverage is lost.
    if (caps?.extractionOrder?.length) {
      for (const tier of caps.extractionOrder) {
        orderedTiersRun.add(tier);
        if (tier === 'platform') {
          if (!isSocialPageUrl(pageUrl)) continue;
          const attempt = await runAttempt('platform-extractors', () => this.deps.extractFromSocialUrl(pageUrl, { skipServer: true }));
          if (attempt.success && attempt.media) {
            const best = pickBestMedia(attempt.media);
            debugLog('[ExtractionManager] success via platform-extractors (ordered) for', pageUrl);
            return { success: true, fatal: false, strategy: 'platform-extractors', confidence: best?.confidence ?? 0.8, media: attempt.media };
          }
          diagnostics['platform-extractors'] = attempt.reason ?? 'no media';
        } else if (tier === 'server') {
          const attempt = await runAttempt('server-extraction', () => this.deps.extractViaServer(pageUrl, session));
          if (attempt.success && attempt.media) {
            debugLog('[ExtractionManager] success via server-extraction (ordered) for', pageUrl);
            return { success: true, fatal: false, strategy: 'server-extraction', confidence: attempt.media.length ? Math.max(...attempt.media.map(m => m.confidence ?? 0.9)) : 0.9, media: attempt.media };
          }
          diagnostics['server-extraction'] = attempt.reason ?? 'no media';
          serverErrorCode = attempt.errorCode;
        } else if (tier === 'browser-probe') {
          if (session?.pageHtml || session?.mediaHints?.length) {
            const attempt = await runAttempt('universal-browser-probe', async () => browserProbeMedia ?? this.deps.probeUniversalMediaFromSession({ pageUrl, pageHtml: session?.pageHtml ?? undefined, mediaHints: session?.mediaHints ?? undefined }));
            if (attempt.success && attempt.media) {
              const best = pickBestMedia(attempt.media);
              debugLog('[ExtractionManager] success via universal-browser-probe (ordered) for', pageUrl);
              return { success: true, fatal: false, strategy: 'universal-browser-probe', confidence: best?.confidence ?? 0.75, media: attempt.media };
            }
            diagnostics['universal-browser-probe'] = attempt.reason ?? 'no strong media';
          }
        } else if (tier === 'browser-embed') {
          const embedResult = await tryBrowserEmbedTier();
          if (embedResult) return embedResult;
        } else if (tier === 'universal-probe') {
          const attempt = await runAttempt('universal-media-probe', async () => autoDownloadableUniversalMedia(await this.deps.probeUniversalMediaFromUrl(pageUrl)));
          if (attempt.success && attempt.media) {
            const best = pickBestMedia(attempt.media);
            debugLog('[ExtractionManager] success via universal-media-probe (ordered) for', pageUrl);
            return { success: true, fatal: false, strategy: 'universal-media-probe', confidence: best?.confidence ?? 0.6, media: attempt.media };
          }
          diagnostics['universal-media-probe'] = attempt.reason ?? 'no media';
        }
      }
      // All configured tiers failed — fall through to remaining default tiers below.
      // Any tier already recorded in diagnostics[] will be skipped by its inline guard.
      debugLog('[ExtractionManager] configured extractionOrder exhausted for', pageUrl, '— continuing with default pipeline');
    }

    // ── Fast path: on-device first for sites the server can't extract without a
    // session (Xiaohongshu). The gated server round-trip is slow and usually
    // fails for these, while the on-device scraper reads the page JSON directly.
    if (caps?.preferOnDevice && isSocialPageUrl(pageUrl) && !diagnostics['platform-extractors']) {
      const attempt = await runAttempt('platform-extractors', () => this.deps.extractFromSocialUrl(pageUrl));
      if (attempt.success && attempt.media) {
        const best = pickBestMedia(attempt.media);
        debugLog('[ExtractionManager] success via on-device (preferOnDevice) for', pageUrl);
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

    // ── Tier 1: server-assisted (yt-dlp backend) ──────────────────────────
    // Try first when a backend is configured; it handles authenticated HD,
    // Japanese sites, DRM-lite scenarios, and everything yt-dlp supports. For
    // preferOnDevice sites this is the fallback after the on-device attempt.
    if (!diagnostics['server-extraction']) {
      const attempt = await runAttempt('server-extraction', () => this.deps.extractViaServer(pageUrl, session));
      if (attempt.success && attempt.media) {
        debugLog('[ExtractionManager] success via server-extraction for', pageUrl);
        return {
          success: true,
          fatal: false,
          strategy: 'server-extraction',
          confidence: attempt.media.length ? Math.max(...attempt.media.map(m => m.confidence ?? 0.9)) : 0.9,
          media: attempt.media,
        };
      }
      diagnostics['server-extraction'] = attempt.reason ?? 'no media';
      serverErrorCode = attempt.errorCode;
      debugLog('[ExtractionManager] server-extraction failed:', attempt.reason);
    }

    // ── Tier 2: platform-specific + HTML detection pipeline ───────────────
    // `extractFromSocialUrl` already has a full non-fatal fallback chain:
    // platform extractor → HLS detector → DASH detector → OG/meta → generic.
    // Skipped when preferOnDevice already ran it above.
    if ((isSocialPageUrl(pageUrl) || caps) && !caps?.preferOnDevice && !diagnostics['platform-extractors']) {
      // skipServer: Tier 1 already tried the server above; don't retry and waste another 45 s timeout.
      const attempt = await runAttempt('platform-extractors', () => this.deps.extractFromSocialUrl(pageUrl, { skipServer: true }));
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

    // ── Tier 3: browser-fed universal parser fallback ───────────────────────
    // Prefer already-captured browser session data over fetching the page again.
    // Results are filtered to high-confidence auto-download candidates.
    if (!diagnostics['universal-browser-probe'] && (session?.pageHtml || session?.mediaHints?.length)) {
      const attempt = await runAttempt('universal-browser-probe', async () => browserProbeMedia ?? this.deps.probeUniversalMediaFromSession({
          pageUrl,
          pageHtml: session?.pageHtml ?? undefined,
          mediaHints: session?.mediaHints ?? undefined,
        }));
      if (attempt.success && attempt.media) {
        const best = pickBestMedia(attempt.media);
        debugLog('[ExtractionManager] success via universal-browser-probe, best:', best?.mediaType, best?.label);
        return {
          success: true,
          fatal: false,
          strategy: 'universal-browser-probe',
          confidence: best?.confidence ?? 0.75,
          media: attempt.media,
        };
      }
      diagnostics['universal-browser-probe'] = attempt.reason ?? 'no strong media';
    }

    // ── Tier 3b: browser-fed embed URL fallback ─────────────────────────────
    // Some pages create the real player iframe only at runtime. The server can
    // extract many of those iframe URLs directly, but it cannot see them unless
    // the WebView sends the rendered HTML snapshot.
    if (!orderedTiersRun.has('browser-embed') && !diagnostics['browser-embed-extraction']) {
      const embedResult = await tryBrowserEmbedTier();
      if (embedResult) return embedResult;
    }

    // ── Tier 4: universal URL fetch fallback ────────────────────────────────
    // Runs only after the existing server/platform paths fail. This keeps known
    // site behaviour stable while making unknown pages and direct media URLs more
    // likely to produce useful candidates.
    if (!diagnostics['universal-media-probe']) {
      const attempt = await runAttempt('universal-media-probe', async () => autoDownloadableUniversalMedia(
        await this.deps.probeUniversalMediaFromUrl(pageUrl),
      ));
      if (attempt.success && attempt.media) {
        const best = pickBestMedia(attempt.media);
        debugLog('[ExtractionManager] success via universal-media-probe, best:', best?.mediaType, best?.label);
        return {
          success: true,
          fatal: false,
          strategy: 'universal-media-probe',
          confidence: best?.confidence ?? 0.6,
          media: attempt.media,
        };
      }
      diagnostics['universal-media-probe'] = attempt.reason ?? 'no media';
    }

    // ── Tier 5: legacy generic fallback — try extractFromSocialUrl even for unknown
    //    URLs (it has a generic HTML media detector chain as last resort).
    if (!isSocialPageUrl(pageUrl) && !caps) {
      // skipServer: Tier 1 already tried the server; avoid a redundant 45 s round-trip.
      const attempt = await runAttempt('generic-html-detection', () => this.deps.extractFromSocialUrl(pageUrl, { skipServer: true }));
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
      errorCode: serverErrorCode,
    };
  }

  /**
   * Convenience: extract and return just the media list (empty on failure).
   * This is a drop-in replacement for callers that used extractFromSocialUrl
   * directly but want the improved fallback + diagnostics.
   */
  async extractMedia(pageUrl: string, session?: ServerExtractOptions): Promise<DetectedMedia[]> {
    const result = await this.extract(pageUrl, session);
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

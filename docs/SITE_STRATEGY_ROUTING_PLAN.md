# Per-Site Extraction Strategy Routing Plan

## Status

Planning document only. No implementation is included in this change.

## Objective

Allow FCDownloader to adjust the order and configuration of extraction
strategies for different websites without replacing the existing fallback
pipelines or changing working behavior by default.

The router should answer:

- Which extraction strategy should run first for this URL?
- Which strategies are useful fallbacks for this website?
- Which request context is required, such as cookies, referer, browser HTML, or
  runtime media hints?
- Which strategies should be skipped because they are known to be ineffective?
- When should the original default pipeline take over?

This concerns **extraction strategy routing**, not selection between media files,
qualities, galleries, or download formats.

## Existing Architecture

FCDownloader already contains most of the required building blocks:

- `src/lib/siteRegistry.ts` stores client-side site capabilities and download
  preferences.
- `src/lib/extractionManager.ts` runs the client extraction fallback tiers.
- `server/registry.py` stores server-side site capabilities.
- `server/strategies.py` builds and executes the server extraction pipeline.
- Both client and server pipelines already treat most strategy failures as
  non-fatal and continue to a fallback.
- Diagnostics and source-audit data already record strategy outcomes.

The main limitation is that extraction order is still partly encoded through
hard-coded conditions such as `preferOnDevice`, YouTube branching, and
`platform_first` hostname lists.

## Design Principles

1. **Preserve current behavior first**
   - The first implementation phase must generate the same strategy order as
     the existing code.
   - A site without an explicit extraction profile must use the current default
     pipeline unchanged.

2. **Extend existing registries**
   - Do not introduce an unrelated third registry.
   - Add extraction-routing fields to the existing client and server
     capability profiles.

3. **Separate extraction from download**
   - Keep the current client `preferredStrategies` field for download methods.
   - Add a separately named field such as `extractionOrder` for extraction
     strategies.
   - Do not mix `direct`, `dash`, or `hls-segments` download choices with
     `server`, `platform`, or `browser-session` extraction choices.

4. **Profiles reorder; they do not remove safety nets**
   - A site profile may prioritize or skip a strategy during its configured
     phase.
   - Unless explicitly marked unsupported, the legacy fallback chain must remain
     available after the configured order is exhausted.

5. **Strategy identifiers must be stable**
   - Use typed or validated identifiers rather than free-form display labels.
   - Logging may use friendly labels, but routing must use stable IDs.

6. **Context-aware execution**
   - A strategy that requires browser HTML, cookies, media hints, or a referer
     should run only when that context is available.
   - Missing context should produce a clear skip reason, not a fatal failure.

7. **One side remains authoritative for its own runtime**
   - The client controls client-capable strategies such as browser-session
     probing and on-device platform extraction.
   - The server controls server-capable strategies such as yt-dlp, custom server
     extractors, structured-data scans, and proxy streaming.

## Proposed Client Model

Introduce a dedicated extraction strategy type, separate from
`DownloadStrategy`.

Example conceptual profile:

```ts
type ClientExtractionStrategy =
  | 'server'
  | 'platform'
  | 'browser-session'
  | 'browser-embed'
  | 'universal-url'
  | 'generic-html';

interface ClientExtractionRouting {
  extractionOrder?: ClientExtractionStrategy[];
  useLegacyFallback?: boolean;
  requiresCookies?: boolean;
  prefersBrowserContext?: boolean;
  strategyTimeoutsMs?: Partial<Record<ClientExtractionStrategy, number>>;
}
```

Initial profiles should reproduce existing behavior. For example:

```ts
instagram: {
  extractionOrder: [
    'server',
    'platform',
    'browser-session',
    'browser-embed',
    'universal-url',
    'generic-html',
  ],
  useLegacyFallback: true,
}
```

The final field names should be chosen during implementation, but extraction and
download strategy types must remain separate.

## Proposed Server Model

Extend `ExtractorCapabilities` with routing metadata that maps to stable server
strategy IDs.

Example conceptual profile:

```python
extraction_order: tuple[str, ...] = ()
disabled_strategies: tuple[str, ...] = ()
use_legacy_fallback: bool = True
```

Potential stable server strategy IDs:

- `platform`
- `yt_dlp`
- `ytdl_stream`
- `structured_data`
- `html_scan`
- `embedded_player`
- `og_image`
- `generic_yt_dlp`
- `browser_fallback`
- `watermark_source`
- `watermark_proxy`

The strategy engine should maintain one strategy factory map:

```text
stable strategy ID -> callable strategy implementation
```

Profiles should build an ordered list from this map. Existing conditional
strategies, such as watermark removal and server-stream support, remain guarded
by their runtime prerequisites.

## Default Compatibility Profiles

Before changing any site behavior, encode the existing routing rules as
profiles or default policies:

- YouTube keeps its dedicated `yt-dlp -> ytdl-stream -> browser fallback`
  server path.
- Existing `preferOnDevice` client sites keep platform extraction before the
  server.
- Existing server `platform_first` sites keep platform extraction before
  yt-dlp.
- Other sites keep the current server-first/client-tier order.
- Unknown websites keep the complete generic fallback chain.
- Watermark strategies retain their current conditional position.

This phase is a refactor of routing representation only, not a behavior change.

## Implementation Phases

### Phase 0: Baseline and Fixtures

- Capture the current client and server strategy order for representative URLs.
- Add fixtures for:
  - YouTube
  - Instagram Reel and carousel post
  - TikTok video and slideshow
  - Vimeo
  - Reddit video and gallery
  - Facebook
  - Bilibili
  - Xiaohongshu
  - Weibo
  - one Japanese HLS site
  - one unknown website
- Record which strategy succeeds, which strategies are skipped, and the final
  result shape.
- Keep live-network tests separate from deterministic routing tests.

### Phase 1: Stable Strategy IDs

- Define client extraction strategy IDs.
- Define server extraction strategy IDs.
- Map existing strategy functions to those IDs.
- Preserve existing log labels and diagnostic output.
- Reject unknown IDs during development and tests.

### Phase 2: Compatibility Router

- Add a router that produces the exact current strategy order.
- Keep the old routing code available behind a temporary compatibility flag.
- Add tests comparing old and new ordered strategy IDs for all baseline URLs.
- Do not enable per-site behavior changes yet.

### Phase 3: Registry Integration

- Add extraction-routing fields to `src/lib/siteRegistry.ts`.
- Add extraction-routing fields to `server/registry.py`.
- Move existing `preferOnDevice` and `platform_first` hostname knowledge into
  explicit profiles where practical.
- Retain compatibility aliases while callers migrate.
- Ensure missing profiles resolve to the unchanged legacy default.

### Phase 4: Shadow Evaluation

- Run the new router in observe-only mode while the old pipeline still executes.
- Log:
  - legacy strategy order;
  - proposed strategy order;
  - differences;
  - unavailable prerequisites;
  - winning strategy and duration.
- Do not send raw cookies, signed media URLs, or sensitive query parameters to
  telemetry.
- Review differences before enabling execution.

### Phase 5: Controlled Enablement

- Enable the new router first for deterministic test environments.
- Enable it for one low-risk website whose proposed order equals current
  behavior.
- Then migrate existing special cases one at a time.
- Keep `useLegacyFallback` enabled for every initial profile.
- Add a kill switch that restores legacy routing without removing profiles.

### Phase 6: Site-Specific Optimization

Only after compatibility is proven:

- Reorder slow or ineffective strategies for individual websites.
- Skip strategies only when tests and diagnostics show they cannot succeed.
- Configure context requirements and optional timeouts.
- Document the evidence and expected benefit beside each non-default profile.

## Execution Rules

The router should apply the following rules:

1. Resolve the most specific matching site profile.
2. Build the configured strategy order.
3. Remove duplicate strategy IDs while preserving order.
4. Exclude strategies whose runtime prerequisites are unavailable.
5. Record an explicit diagnostic for each prerequisite-based skip.
6. Execute strategies in order.
7. Continue after non-fatal failures.
8. Stop on a successful acceptable result.
9. Stop on a truly fatal result such as confirmed DRM or invalid input.
10. If configured strategies are exhausted and `useLegacyFallback` is enabled,
    append untried strategies from the original default pipeline.

## Regression Safeguards

- Never change routing and extraction output normalization in the same phase.
- Never change client and server ordering simultaneously for the first rollout
  of a website.
- Preserve direct-media short circuits.
- Preserve explicit gallery, playlist, paired audio/video, subtitle, and HLS or
  DASH result contracts.
- Preserve server result acceptability guards.
- Deduplicate strategy IDs so a server call or yt-dlp attempt is not repeated.
- Cap strategy attempts and total extraction time.
- Keep strategy errors isolated and non-fatal unless explicitly classified.
- Treat profile parsing or unknown strategy IDs as a fallback-to-legacy event.

## Test Plan

### Unit Tests

- URL-to-profile matching.
- Most-specific profile precedence.
- Default profile behavior.
- Strategy-order generation.
- Duplicate removal.
- Runtime prerequisite filtering.
- Unknown strategy handling.
- Legacy fallback appending.
- Fatal versus non-fatal behavior.

### Compatibility Tests

- Assert that compatibility-router order matches current order for all baseline
  URLs.
- Assert that no strategy runs twice.
- Assert that profiles without extraction fields retain current behavior.
- Assert that download strategy recommendation remains unchanged.

### Integration Tests

- Mock strategy success and failure at every position.
- Verify cookie, referer, browser HTML, and media-hint forwarding.
- Verify diagnostics identify the attempted and winning strategy.
- Verify the original fallback succeeds when all configured strategies fail.

### End-to-End Verification

- Run TypeScript type checking and the existing client test suites.
- Run the complete server test suite.
- Test representative URLs with deterministic fixtures.
- Run an optional live-site matrix separately because external website behavior
  is unstable.
- Compare success rate, winning strategy, extraction time, and result kind
  before and after enablement.

## Observability

For each extraction request, record sanitized data:

- matched profile ID;
- generated strategy order;
- strategy start, success, failure, or skip;
- duration;
- failure category;
- winning strategy;
- whether legacy fallback was used.

Do not record:

- cookie values;
- authorization headers;
- unredacted signed URLs;
- private media identifiers beyond existing sanitized audit policy.

## Rollback Strategy

- Keep a global legacy-routing switch during migration.
- Allow client and server routing to be rolled back independently.
- Treat invalid profiles as legacy defaults.
- Do not delete the old hard-coded routing until compatibility and controlled
  rollout tests have passed.
- Remove compatibility code only after multiple releases show no routing
  regressions.

## Initial Scope

The first implementation should:

- introduce stable extraction strategy IDs;
- generate current behavior from a compatibility router;
- add deterministic routing tests;
- add registry fields without changing any site order;
- add shadow diagnostics;
- leave all optimization profiles disabled.

The first implementation should **not**:

- redesign media result selection;
- rewrite extractors;
- remove existing fallbacks;
- disable strategies for any site;
- change download strategy selection;
- add automatic strategy reordering based on production telemetry.

## Completion Criteria

The routing foundation is ready when:

- current strategy order is reproduced for all baseline fixtures;
- existing tests pass without changed result contracts;
- unknown sites retain the full fallback pipeline;
- client and server diagnostics expose the generated order;
- legacy routing can be restored with one switch;
- a single site can be configured without editing the central execution loop.

Only after these criteria are met should FCDownloader begin changing strategy
order for individual websites.

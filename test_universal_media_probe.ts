import assert from 'node:assert/strict';
import { autoDownloadableUniversalMedia, probeUniversalMedia } from './src/lib/universalMediaProbe';

const pageUrl = 'https://example.com/articles/post';
const html = `
<!doctype html>
<html>
<head>
  <meta property="og:video" content="/media/hero.mp4?token=abc&amp;quality=hd">
  <meta property="og:image" content="https://cdn.example.com/thumbs/hero.jpg">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    "name": "Launch clip",
    "contentUrl": "https://stream.example.com/live/master.m3u8",
    "thumbnailUrl": "https://cdn.example.com/thumbs/launch.jpg"
  }
  </script>
</head>
<body>
  <video poster="/posters/frame.webp">
    <source src="https://cdn.example.com/video/clip.webm" type="video/webm">
  </video>
  <img src="https://cdn.example.com/favicon.png">
  <img src="https://cdn.example.com/gallery/photo.avif">
  <script>
    window.__DATA__ = {"dash":"https:\\/\\/media.example.com\\/manifest.mpd"};
  </script>
</body>
</html>`;

const media = probeUniversalMedia({
  pageUrl,
  pageHtml: html,
  mediaHints: [
  {
    url: 'https://resources.example.com/audio/theme.ogg',
    mimeType: 'audio/ogg',
    source: 'resource-timing',
    },
  ],
});

const urls = media.map((item) => item.url);

assert(urls.includes('https://resources.example.com/audio/theme.ogg'));
assert(urls.includes('https://example.com/media/hero.mp4?token=abc&quality=hd'));
assert(urls.includes('https://stream.example.com/live/master.m3u8'));
assert(urls.includes('https://cdn.example.com/video/clip.webm'));
assert(urls.includes('https://cdn.example.com/gallery/photo.avif'));
assert(urls.includes('https://media.example.com/manifest.mpd'));
assert(!urls.includes('https://cdn.example.com/favicon.png'));

const hls = media.find((item) => item.url.includes('master.m3u8'));
assert.equal(hls?.mediaType, 'hls');
assert.equal(hls?.mediaKind, 'video');
assert.equal(hls?.extractor, 'universal-probe');

const audio = media.find((item) => item.url.includes('theme.ogg'));
assert.equal(audio?.mediaKind, 'audio');
assert.equal(audio?.mediaType, 'direct');

const image = media.find((item) => item.url.includes('photo.avif'));
assert.equal(image?.mediaKind, 'image');

const browserFed = probeUniversalMedia({
  pageUrl,
  pageHtml: `
    <meta property="og:image" content="https://cdn.example.com/share-card.jpg">
    <script type="application/ld+json">
      {"@type":"VideoObject","contentUrl":"https:\\/\\/media.example.com\\/video.mpd"}
    </script>
  `,
  mediaHints: [
    {
      url: 'https://cdn.example.com/player/clip.mp4',
      mimeType: 'video/mp4',
      confidence: 0.86,
      source: 'media-element',
    },
    {
      url: 'https://cdn.example.com/network/master.m3u8',
      kind: 'hls',
      confidence: 0.78,
      source: 'network-log',
    },
    {
      url: 'https://cdn.example.com/gallery/thumbnail.jpg',
      kind: 'image',
      confidence: 0.52,
      source: 'generic-url',
    },
  ],
});
const auto = autoDownloadableUniversalMedia(browserFed);
assert(auto.some((item) => item.url.endsWith('/clip.mp4')));
assert(auto.some((item) => item.url.endsWith('/master.m3u8')));
assert(auto.some((item) => item.url.endsWith('/video.mpd')));
assert(!auto.some((item) => item.url.endsWith('/share-card.jpg')));
assert(!auto.some((item) => item.url.endsWith('/thumbnail.jpg')));

const openGraphImageOnly = autoDownloadableUniversalMedia(probeUniversalMedia({
  pageUrl,
  pageHtml: '<meta property="og:image" content="https://cdn.example.com/share-card.jpg">',
}));
assert.deepEqual(openGraphImageOnly.map((item) => item.url), ['https://cdn.example.com/share-card.jpg']);

const openGraphTypeOnly = probeUniversalMedia({
  pageUrl,
  pageHtml: `
    <meta property="og:video:type" content="video/mp4">
    <meta property="og:video:width" content="1280">
    <meta property="twitter:player:stream:content_type" content="video/mp4">
  `,
});
assert.equal(openGraphTypeOnly.length, 0);

const openGraphTypedMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `
    <meta property="og:video" content="https://stream.example.com/og/master">
    <meta property="og:video:type" content="application/vnd.apple.mpegurl">
    <meta property="og:audio" content="https://audio.example.com/podcast/episode">
    <meta property="og:audio:type" content="audio/mpeg">
  `,
});
const typedOgHls = openGraphTypedMedia.find((item) => item.url === 'https://stream.example.com/og/master');
const typedOgAudio = openGraphTypedMedia.find((item) => item.url === 'https://audio.example.com/podcast/episode');
assert.equal(typedOgHls?.mediaType, 'hls');
assert.equal(typedOgHls?.mimeType, 'application/vnd.apple.mpegurl');
assert.equal(typedOgAudio?.mediaKind, 'audio');
assert.equal(typedOgAudio?.mimeType, 'audio/mpeg');

const microdataMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `
    <div itemscope itemtype="https://schema.org/VideoObject">
      <meta itemprop="contentUrl" content="/schema/clip.mp4">
      <link itemprop="contentUrl" href="https://stream.example.com/schema/master" type="application/vnd.apple.mpegurl">
      <a itemprop="downloadUrl" href="https://cdn.example.com/schema/download.webm">Download</a>
      <img itemprop="thumbnailUrl" src="https://cdn.example.com/schema/thumb.webp">
      <meta itemprop="url" content="https://example.com/articles/canonical">
    </div>
  `,
});
const microdataUrls = microdataMedia.map((item) => item.url);
assert(microdataUrls.includes('https://example.com/schema/clip.mp4'));
assert(microdataUrls.includes('https://stream.example.com/schema/master'));
assert(microdataUrls.includes('https://cdn.example.com/schema/download.webm'));
assert(microdataUrls.includes('https://cdn.example.com/schema/thumb.webp'));
assert(!microdataUrls.includes('https://example.com/articles/canonical'));
const microdataHls = microdataMedia.find((item) => item.url === 'https://stream.example.com/schema/master');
assert.equal(microdataHls?.mediaType, 'hls');
assert.equal(microdataHls?.sourceAudit?.[0]?.strategy, 'schema-microdata');
const microdataThumb = microdataMedia.find((item) => item.url.endsWith('/thumb.webp'));
assert.equal(microdataThumb?.mediaKind, 'image');

const imageOnly = autoDownloadableUniversalMedia(probeUniversalMedia({
  pageUrl,
  mediaHints: [
    { url: 'https://cdn.example.com/gallery/fullsize.webp', kind: 'image', confidence: 0.84 },
    { url: 'https://cdn.example.com/gallery/small.jpg', kind: 'image', confidence: 0.5 },
  ],
}));
assert.deepEqual(imageOnly.map((item) => item.url), ['https://cdn.example.com/gallery/fullsize.webp']);

const responsiveImageMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `
    <picture>
      <source type="image/webp" srcset="https://cdn.example.com/responsive/small.webp 480w, https://cdn.example.com/responsive/large.webp 1600w">
      <img srcset="/responsive/fallback-small.jpg 1x, /responsive/fallback-large.jpg 2x">
    </picture>
    <link rel="preload" as="image" imagesrcset="https://cdn.example.com/preload/small.jpg 400w, https://cdn.example.com/preload/large.jpg 1200w" type="image/jpeg">
  `,
});
const responsiveUrls = responsiveImageMedia.map((item) => item.url);
assert(responsiveUrls.includes('https://cdn.example.com/responsive/large.webp'));
assert(responsiveUrls.includes('https://example.com/responsive/fallback-large.jpg'));
assert(responsiveUrls.includes('https://cdn.example.com/preload/large.jpg'));
const responsiveLarge = responsiveImageMedia.find((item) => item.url === 'https://cdn.example.com/responsive/large.webp');
assert.equal(responsiveLarge?.mediaKind, 'image');
assert(responsiveLarge?.confidence && responsiveLarge.confidence >= 0.8);
const responsiveAutoUrls = autoDownloadableUniversalMedia(responsiveImageMedia).map((item) => item.url);
assert(!responsiveAutoUrls.includes('https://cdn.example.com/responsive/small.webp'));

const dataAttributeMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `
    <div data-hls-url="https://stream.example.com/data/master"></div>
    <button data-video-url="https://cdn.example.com/data/clip.mp4"></button>
    <img data-original="https://cdn.example.com/data/original.webp">
    <div data-srcset="https://cdn.example.com/data/small.jpg 480w, https://cdn.example.com/data/large.jpg 1440w"></div>
    <div data-api-url="https://api.example.com/media/config"></div>
  `,
});
const dataAttributeUrls = dataAttributeMedia.map((item) => item.url);
assert(dataAttributeUrls.includes('https://stream.example.com/data/master'));
assert(dataAttributeUrls.includes('https://cdn.example.com/data/clip.mp4'));
assert(dataAttributeUrls.includes('https://cdn.example.com/data/original.webp'));
assert(dataAttributeUrls.includes('https://cdn.example.com/data/large.jpg'));
assert(!dataAttributeUrls.includes('https://api.example.com/media/config'));
const dataHls = dataAttributeMedia.find((item) => item.url === 'https://stream.example.com/data/master');
assert.equal(dataHls?.mediaType, 'hls');
assert.equal(dataHls?.sourceAudit?.[0]?.strategy, 'data-attribute');

const cssBackgroundMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `
    <div style="background-image: url('/assets/hero-large.webp')"></div>
    <style>
      .gallery { background: url("https://cdn.example.com/css/gallery.jpg") center / cover; }
      @font-face { src: url("https://cdn.example.com/fonts/site.woff2"); }
    </style>
  `,
});
const cssUrls = cssBackgroundMedia.map((item) => item.url);
assert(cssUrls.includes('https://example.com/assets/hero-large.webp'));
assert(cssUrls.includes('https://cdn.example.com/css/gallery.jpg'));
assert(!cssUrls.includes('https://cdn.example.com/fonts/site.woff2'));
const cssHero = cssBackgroundMedia.find((item) => item.url === 'https://example.com/assets/hero-large.webp');
assert.equal(cssHero?.mediaKind, 'image');
assert.equal(cssHero?.sourceAudit?.[0]?.strategy, 'css-background');
assert(cssHero?.confidence && cssHero.confidence >= 0.8);

const resourceLinkMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `
    <link rel="preload" as="video" href="https://cdn.example.com/preload/clip" type="video/mp4">
    <link rel="preload" as="fetch" href="https://stream.example.com/preload/master" type="application/vnd.apple.mpegurl">
    <link rel="preload" as="fetch" href="https://api.example.com/data.json" type="application/json">
    <a download="original.mp4" href="https://cdn.example.com/download/original.mp4">Download</a>
  `,
});
const resourceUrls = resourceLinkMedia.map((item) => item.url);
assert(resourceUrls.includes('https://cdn.example.com/preload/clip'));
assert(resourceUrls.includes('https://stream.example.com/preload/master'));
assert(resourceUrls.includes('https://cdn.example.com/download/original.mp4'));
assert(!resourceUrls.includes('https://api.example.com/data.json'));
const preloadedVideo = resourceLinkMedia.find((item) => item.url === 'https://cdn.example.com/preload/clip');
assert.equal(preloadedVideo?.mediaType, 'direct');
assert.equal(preloadedVideo?.mediaKind, 'video');
assert.equal(preloadedVideo?.provenance, 'page-global');
assert(preloadedVideo?.confidence && preloadedVideo.confidence >= 0.75);
const preloadedHls = resourceLinkMedia.find((item) => item.url === 'https://stream.example.com/preload/master');
assert.equal(preloadedHls?.mediaType, 'hls');
assert.equal(preloadedHls?.sourceAudit?.[0]?.strategy, 'resource-link');

const playerConfigMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `
    <script>
      jwplayer("player").setup({
        playlist: [{
          sources: [
            { file: "/relative/live/master.m3u8", type: "application/vnd.apple.mpegurl" },
            { file: "../relative/movie.mpd", type: "application/dash+xml" },
            { file: "https://player.example.com/live/playlist", type: "application/vnd.apple.mpegurl" },
            { file: "https://cdn.example.com/video/fallback.mp4", type: "video/mp4" }
          ],
          media_url: "/relative/typed-clip",
          type: "video/mp4",
          image: "https://cdn.example.com/poster/player-cover.jpg"
        }],
        api: "https://api.example.com/player/config"
      });
      videojs("v").src({ src: "https://media.example.com/movie.mpd", type: "application/dash+xml" });
    </script>
  `,
});
const playerUrls = playerConfigMedia.map((item) => item.url);
assert(playerUrls.includes('https://example.com/relative/live/master.m3u8'));
assert(playerUrls.includes('https://example.com/relative/movie.mpd'));
assert(playerUrls.includes('https://example.com/relative/typed-clip'));
assert(playerUrls.includes('https://player.example.com/live/playlist'));
assert(playerUrls.includes('https://cdn.example.com/video/fallback.mp4'));
assert(playerUrls.includes('https://media.example.com/movie.mpd'));
assert(!playerUrls.includes('https://api.example.com/player/config'));
assert.equal(playerConfigMedia.find((item) => item.url.endsWith('/relative/live/master.m3u8'))?.mediaType, 'hls');
assert.equal(playerConfigMedia.find((item) => item.url.endsWith('/relative/movie.mpd'))?.mediaType, 'dash');
assert.equal(playerConfigMedia.find((item) => item.url.endsWith('/relative/typed-clip'))?.mediaKind, 'video');
const extensionlessHls = playerConfigMedia.find((item) => item.url === 'https://player.example.com/live/playlist');
assert.equal(extensionlessHls?.mediaType, 'hls');
assert.equal(extensionlessHls?.provenance, 'player-sdk-hook');
assert(extensionlessHls?.confidence && extensionlessHls.confidence >= 0.75);

const hydrationMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `
    <script id="__NEXT_DATA__" type="application/json">
      {
        "props": {
          "pageProps": {
            "video": {
              "hlsUrl": "https:\\/\\/stream.example.com\\/playback\\/primary",
              "contentType": "application/vnd.apple.mpegurl",
              "dashUrl": "https:\\/\\/stream.example.com\\/playback\\/manifest",
              "mimeType": "application/dash+xml",
              "videoUrl": "https:\\/\\/cdn.example.com\\/hydrated\\/clip.mp4",
              "poster": "https:\\/\\/cdn.example.com\\/hydrated\\/poster.jpg"
            },
            "api": "https:\\/\\/api.example.com\\/content\\/config"
          }
        }
      }
    </script>
  `,
});
const hydrationUrls = hydrationMedia.map((item) => item.url);
assert(hydrationUrls.includes('https://stream.example.com/playback/primary'));
assert(hydrationUrls.includes('https://stream.example.com/playback/manifest'));
assert(hydrationUrls.includes('https://cdn.example.com/hydrated/clip.mp4'));
assert(hydrationUrls.includes('https://cdn.example.com/hydrated/poster.jpg'));
assert(!hydrationUrls.includes('https://api.example.com/content/config'));
const hydrationHls = hydrationMedia.find((item) => item.url === 'https://stream.example.com/playback/primary');
assert.equal(hydrationHls?.mediaType, 'hls');
assert.equal(hydrationHls?.provenance, 'page-global');
assert.equal(hydrationHls?.sourceAudit?.[0]?.strategy, 'page-hydration-data');

const relativeHydrationMedia = probeUniversalMedia({
  pageUrl: 'https://example.com/articles/story',
  pageHtml: `
    <base href="https://cdn.example.com/assets/">
    <script id="__NEXT_DATA__" type="application/json">
      {
        "props": {
          "pageProps": {
            "video": {
              "hlsUrl": "streams/master.m3u8",
              "dashUrl": "./dash/manifest.mpd",
              "videoUrl": "../video/clip.mp4",
              "poster": "/posters/frame.webp"
            },
            "api": "/api/content/config"
          }
        }
      }
    </script>
  `,
});
const relativeHydrationUrls = relativeHydrationMedia.map((item) => item.url);
assert(relativeHydrationUrls.includes('https://cdn.example.com/assets/streams/master.m3u8'));
assert(relativeHydrationUrls.includes('https://cdn.example.com/assets/dash/manifest.mpd'));
assert(relativeHydrationUrls.includes('https://cdn.example.com/video/clip.mp4'));
assert(relativeHydrationUrls.includes('https://cdn.example.com/posters/frame.webp'));
assert(!relativeHydrationUrls.includes('https://cdn.example.com/api/content/config'));
assert.equal(relativeHydrationMedia.find((item) => item.url.endsWith('/streams/master.m3u8'))?.mediaType, 'hls');
assert.equal(relativeHydrationMedia.find((item) => item.url.endsWith('/dash/manifest.mpd'))?.mediaType, 'dash');

const baseHrefMedia = probeUniversalMedia({
  pageUrl: 'https://example.com/articles/story',
  pageHtml: `
    <base href="https://cdn.example.com/assets/">
    <video src="clips/main.mp4"></video>
    <img srcset="thumb-small.jpg 320w, thumb-large.webp 1280w">
    <link rel="preload" as="video" href="streams/live.m3u8" type="application/vnd.apple.mpegurl">
    <style>.hero { background-image: url("images/hero.webp"); }</style>
    <script type="application/ld+json">
      {"@type":"VideoObject","contentUrl":"json/video.mp4","thumbnailUrl":"json/poster.jpg"}
    </script>
  `,
});
const baseHrefUrls = baseHrefMedia.map((item) => item.url);
assert(baseHrefUrls.includes('https://cdn.example.com/assets/clips/main.mp4'));
assert(baseHrefUrls.includes('https://cdn.example.com/assets/thumb-large.webp'));
assert(baseHrefUrls.includes('https://cdn.example.com/assets/streams/live.m3u8'));
assert(baseHrefUrls.includes('https://cdn.example.com/assets/images/hero.webp'));
assert(baseHrefUrls.includes('https://cdn.example.com/assets/json/video.mp4'));
const baseHrefVideo = baseHrefMedia.find((item) => item.url === 'https://cdn.example.com/assets/clips/main.mp4');
assert.equal(baseHrefVideo?.pageUrl, 'https://example.com/articles/story');
assert.equal(baseHrefVideo?.sourcePageUrl, 'https://example.com/articles/story');

// ── ISO 8601 duration parsing in JSON-LD ─────────────────────────────────────
const isoDurationMedia = probeUniversalMedia({
  pageUrl: 'https://podcast.example.com/episode/42',
  pageHtml: `
    <title>Ep 42: The Finale</title>
    <script type="application/ld+json">
    {
      "@type": "PodcastEpisode",
      "contentUrl": "https://cdn.example.com/ep42.mp3",
      "duration": "PT1H32M45S",
      "name": "The Finale"
    }
    </script>
  `,
});
const ep42 = isoDurationMedia.find((item) => item.url.includes('ep42.mp3'));
assert.ok(ep42, 'ISO 8601 duration episode not found');
// PT1H32M45S = 3600 + 1920 + 45 = 5565
assert.equal(ep42!.duration, 5565);
// sourceTitle should be populated from <title>
assert.equal(ep42!.sourceTitle, 'Ep 42: The Finale');

const isoDurationMinutes = probeUniversalMedia({
  pageUrl: 'https://example.com/clip',
  pageHtml: `
    <script type="application/ld+json">
    {"@type":"VideoObject","contentUrl":"https://cdn.example.com/clip.mp4","duration":"PT4M20S"}
    </script>
  `,
});
const clip = isoDurationMinutes.find((item) => item.url.includes('clip.mp4'));
assert.ok(clip, 'ISO 8601 PT4M20S not found');
// PT4M20S = 240 + 20 = 260
assert.equal(clip!.duration, 260);

// ── <video> width/height attribute propagation ────────────────────────────────
const videoAttrsMedia = probeUniversalMedia({
  pageUrl: 'https://example.com/player',
  pageHtml: `
    <video src="https://cdn.example.com/promo.mp4" width="1280" height="720"></video>
    <img src="https://cdn.example.com/photo.jpg" width="800" height="600">
  `,
});
const promoVideo = videoAttrsMedia.find((item) => item.url.includes('promo.mp4'));
assert.ok(promoVideo, '<video> with explicit width/height not found');
assert.equal(promoVideo!.width, 1280);
assert.equal(promoVideo!.height, 720);

const photoItem = videoAttrsMedia.find((item) => item.url.includes('photo.jpg'));
assert.ok(photoItem, '<img> with explicit width/height not found');
assert.equal(photoItem!.width, 800);
assert.equal(photoItem!.height, 600);

// ── DASH live stream detection (type=dynamic) ─────────────────────────────────
// (Tested separately in test_universal_manifest_inspector.ts — sentinel check only)
const dashLiveStaticMPD = probeUniversalMedia({
  pageUrl: 'https://live.example.com/event',
  pageHtml: `<video src="https://live.example.com/event/manifest.mpd"></video>`,
});
const dashLiveItem = dashLiveStaticMPD.find((item) => item.url.includes('manifest.mpd'));
assert.ok(dashLiveItem, 'DASH MPD not detected via <video> src');

// ── Kaltura player embed detection ────────────────────────────────────────────
const kalturaMedia = probeUniversalMedia({
  pageUrl: 'https://university.example.edu/lecture/42',
  pageHtml: `
    <div id="kalturaPlayer"></div>
    <script>
      kWidget.embed({
        targetId: "kalturaPlayer",
        wid: "_1234567",
        uiconf_id: 23448190,
        entry_id: "1_abc12def"
      });
    </script>
  `,
});
const kalturaItem = kalturaMedia.find((m) => m.url.includes('cdnapisec.kaltura.com'));
assert.ok(kalturaItem, 'Kaltura HLS manifest not detected from kWidget.embed()');
assert.match(kalturaItem!.url, /\/p\/1234567\//);
assert.match(kalturaItem!.url, /entryId\/1_abc12def\//);
assert.ok(kalturaItem!.url.endsWith('manifest.m3u8'), 'Kaltura URL should end with manifest.m3u8');
assert.equal(kalturaItem!.mediaType, 'hls');

// Kaltura v7 style (KalturaPlayer.setup)
const kalturaV7Media = probeUniversalMedia({
  pageUrl: 'https://media.example.com/watch',
  pageHtml: `
    <script>
      var player = KalturaPlayer.setup({
        targetId: "kaltura_player",
        provider: { partnerId: 9876543, uiConfId: 44629851 }
      });
      player.loadMedia({ entryId: "1_xyz99abc" });
    </script>
  `,
});
// KalturaPlayer.setup uses partnerId differently; should still detect entry_id from loadMedia
const kv7Item = kalturaV7Media.find((m) => m.url.includes('cdnapisec.kaltura.com'));
assert.ok(kv7Item, 'Kaltura V7 not detected');
assert.match(kv7Item!.url, /entryId\/1_xyz99abc/);

// Ensure unknown Kaltura-like text without valid wid/entry_id doesn't produce noise
const kNoMatch = probeUniversalMedia({
  pageUrl: 'https://example.com/page',
  pageHtml: `<script>kWidget.embed({ targetId: "player" });</script>`,
});
assert.ok(!kNoMatch.some((m) => m.url.includes('cdnapisec.kaltura.com')), 'Kaltura match without IDs should not emit');

// ── AMP video element detection ───────────────────────────────────────────────
const ampVideoMedia = probeUniversalMedia({
  pageUrl: 'https://amp.example.com/article',
  pageHtml: `
    <!doctype html>
    <html amp>
    <body>
      <amp-video src="https://cdn.example.com/amp/promo.mp4" width="640" height="360" poster="https://cdn.example.com/amp/poster.jpg">
        <source src="https://cdn.example.com/amp/promo-hd.mp4" type="video/mp4">
      </amp-video>
      <amp-audio src="https://cdn.example.com/amp/podcast.mp3"></amp-audio>
    </body>
    </html>
  `,
});
const ampVideoUrls = ampVideoMedia.map((m) => m.url);
assert(ampVideoUrls.includes('https://cdn.example.com/amp/promo.mp4'), '<amp-video> src not detected');
assert(ampVideoUrls.includes('https://cdn.example.com/amp/podcast.mp3'), '<amp-audio> src not detected');
const ampVideoItem = ampVideoMedia.find((m) => m.url.includes('promo.mp4'));
assert.equal(ampVideoItem?.mediaKind, 'video', '<amp-video> should have mediaKind=video');
assert.equal(ampVideoItem?.width, 640, '<amp-video> width not propagated');
assert.equal(ampVideoItem?.height, 360, '<amp-video> height not propagated');
const ampAudioItem = ampVideoMedia.find((m) => m.url.includes('podcast.mp3'));
assert.equal(ampAudioItem?.mediaKind, 'audio', '<amp-audio> should have mediaKind=audio');

// ── AMP social embed detection (<amp-youtube>, <amp-vimeo>, etc.) ─────────────
const ampYouTubeMedia = probeUniversalMedia({
  pageUrl: 'https://amp.publisher.com/article/with-video',
  pageHtml: `
    <html amp>
    <body>
      <amp-youtube data-videoid="dQw4w9WgXcQ" layout="responsive" width="480" height="270"></amp-youtube>
      <amp-vimeo data-videoid="76979871" layout="responsive" width="16" height="9"></amp-vimeo>
      <amp-dailymotion data-videoid="x7tgd28" layout="responsive" width="480" height="270"></amp-dailymotion>
    </body>
    </html>
  `,
});
const ampEmbedUrls = ampYouTubeMedia.map((m) => m.url);
assert(ampEmbedUrls.some((u) => u.includes('youtube.com/embed/dQw4w9WgXcQ')), '<amp-youtube> not converted to embed URL');
assert(ampEmbedUrls.some((u) => u.includes('player.vimeo.com/video/76979871')), '<amp-vimeo> not converted to embed URL');
assert(ampEmbedUrls.some((u) => u.includes('dailymotion.com/embed/video/x7tgd28')), '<amp-dailymotion> not converted to embed URL');
const ytAmpItem = ampYouTubeMedia.find((m) => m.url.includes('youtube.com/embed'));
assert.equal(ytAmpItem?.forceServerDownload, true, '<amp-youtube> should have forceServerDownload=true');
assert.equal(ytAmpItem?.mediaKind, 'video');

// ── JSON-LD ItemList / ListItem traversal ─────────────────────────────────────
const itemListMedia = probeUniversalMedia({
  pageUrl: 'https://podcast.example.com/playlist/42',
  pageHtml: `
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": "Top Episodes",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "item": {
            "@type": "PodcastEpisode",
            "name": "Episode 1: The Beginning",
            "contentUrl": "https://cdn.example.com/ep1.mp3",
            "duration": "PT45M30S"
          }
        },
        {
          "@type": "ListItem",
          "position": 2,
          "item": {
            "@type": "VideoObject",
            "name": "Video Recap",
            "contentUrl": "https://cdn.example.com/recap.mp4"
          }
        }
      ]
    }
    </script>
  `,
});
const itemListUrls = itemListMedia.map((m) => m.url);
assert(itemListUrls.includes('https://cdn.example.com/ep1.mp3'), 'ItemList ep1 not found');
assert(itemListUrls.includes('https://cdn.example.com/recap.mp4'), 'ItemList recap not found');
const ep1Item = itemListMedia.find((m) => m.url.includes('ep1.mp3'));
assert.equal(ep1Item?.duration, 45 * 60 + 30, 'Episode duration not propagated from ItemList');

// Background video confidence penalty
const bgVideoMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<video autoplay loop muted playsinline src="https://cdn.example.com/bg/hero.mp4"></video>`,
});
const bgVideoItem = bgVideoMedia.find((m) => m.url.includes('hero.mp4'));
assert.ok(bgVideoItem, 'Background video should still be detected');
assert.ok((bgVideoItem?.confidence ?? 1) < 0.75, 'Background video confidence should be below auto-download threshold');

// Controls video keeps full confidence
const controlsVideoMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<video controls src="https://cdn.example.com/main/episode.mp4"></video>`,
});
const controlsItem = controlsVideoMedia.find((m) => m.url.includes('episode.mp4'));
assert.ok(controlsItem, 'Video with controls should be detected');
assert.ok((controlsItem?.confidence ?? 0) >= 0.75, 'Video with controls should have full confidence');

// Wistia div embed detection
const wistiaMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<div class="wistia_embed wistia_async_abc123xyz" style="width:640px;height:360px;">&nbsp;</div>`,
});
const wistiaItem = wistiaMedia.find((m) => m.url.includes('wistia.com/embed/iframe/abc123xyz'));
assert.ok(wistiaItem, 'Wistia div embed should be detected');
assert.equal(wistiaItem?.forceServerDownload, true, 'Wistia embed should have forceServerDownload=true');
assert.equal(wistiaItem?.mediaKind, 'video', 'Wistia embed should have mediaKind=video');

// Brightcove native Video.js div embed detection
const bcDivMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<video-js data-account="1234567890" data-video-id="ref:my-promo-video" data-player="H1xP2rEWl" data-embed="default" controls class="vjs-fluid"></video-js>`,
});
const bcItem = bcDivMedia.find((m) => m.url.includes('players.brightcove.net'));
assert.ok(bcItem, 'Brightcove video-js div embed should be detected');
assert.ok(bcItem?.url.includes('1234567890'), 'Brightcove account ID should be in URL');
assert.ok(bcItem?.url.includes('my-promo-video'), 'Brightcove video ID should be in URL');
assert.equal(bcItem?.forceServerDownload, true, 'Brightcove embed should have forceServerDownload=true');

// Consent-deferred iframe embed (GDPR cookie consent pattern) — src="about:blank" first
const consentIframeMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<iframe src="about:blank" data-consent-src="https://player.vimeo.com/video/987654321" width="640" height="360"></iframe>`,
});
const consentItem = consentIframeMedia.find((m) => m.url.includes('player.vimeo.com/video/987654321'));
assert.ok(consentItem, 'Consent-deferred iframe (data-consent-src) should be detected even when src="about:blank" comes first');
assert.equal(consentItem?.forceServerDownload, true, 'Consent iframe embed should have forceServerDownload=true');

// CMP-deferred iframe (OneTrust / data-cmp-src pattern)
const cmpIframeMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<iframe data-cmp-src="https://www.youtube.com/embed/dQw4w9WgXcQ" src="about:blank"></iframe>`,
});
const cmpItem = cmpIframeMedia.find((m) => m.url.includes('youtube.com/embed'));
assert.ok(cmpItem, 'CMP-deferred iframe (data-cmp-src) should be detected');

// Next.js image optimizer URL unwrapping
const nextImgMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<img src="/_next/image?url=https%3A%2F%2Fcdn.example.com%2Fphotos%2Foriginal.jpg&amp;w=1920&amp;q=75" width="1920" height="1080">`,
});
const nextImgItem = nextImgMedia.find((m) => m.url === 'https://cdn.example.com/photos/original.jpg');
assert.ok(nextImgItem, 'Next.js image optimizer URL should be unwrapped to original CDN URL');

// Cloudflare Stream <stream> custom element
const cfStreamMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<stream src="5d5bc37ffcf54c9b82e996823bffbb81" controls loop></stream>`,
});
const cfStreamItem = cfStreamMedia.find((m) => m.url.includes('iframe.cloudflarestream.com/5d5bc37ffcf54c9b82e996823bffbb81'));
assert.ok(cfStreamItem, 'Cloudflare Stream <stream> element should be detected');
assert.equal(cfStreamItem?.forceServerDownload, true, 'Cloudflare Stream embed should have forceServerDownload=true');

// AMP JW Player embed
const ampJwMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<amp-jwplayer data-player-id="abc12345" data-media-id="xyz67890" layout="responsive" width="16" height="9"></amp-jwplayer>`,
});
const ampJwItem = ampJwMedia.find((m) => m.url.includes('content.jwplatform.com/players/xyz67890-abc12345.html'));
assert.ok(ampJwItem, 'amp-jwplayer element should reconstruct JW Platform embed URL');
assert.equal(ampJwItem?.forceServerDownload, true, 'amp-jwplayer embed should have forceServerDownload=true');

// flv_url hydration data key
const flvMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script id="__INITIAL_STATE__" type="application/json">{"flv_url":"https://live.example.com/stream/abc.flv?key=xyz"}</script>`,
});
const flvItem = flvMedia.find((m) => m.url.includes('live.example.com/stream/abc.flv'));
assert.ok(flvItem, 'flv_url hydration key should be extracted');

// Smooth Streaming (.ism/manifest) detected as DASH-like
const smoothMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>var p=amp('v',{src:[{src:'https://example.streaming.mediaservices.windows.net/video.ism/manifest',type:'application/vnd.ms-sstr+xml'}]});</script>`,
});
const smoothItem = smoothMedia.find((m) => m.url.includes('.ism/manifest'));
assert.ok(smoothItem, 'Smooth Streaming .ism/manifest URL should be detected');
assert.equal(smoothItem?.mediaType, 'dash', 'Smooth Streaming should be classified as dash type');

// subtitle_url hydration key
const subtitleMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"video":{"vtt_url":"https://cdn.example.com/captions/en.vtt","video_url":"https://cdn.example.com/video.mp4"}}}}</script>`,
});
const subtitleItem = subtitleMedia.find((m) => m.url.includes('captions/en.vtt'));
assert.ok(subtitleItem, 'vtt_url hydration key should surface subtitle URL');

// caption_url hydration key with .webvtt extension (Round 23: TS parity with Python's
// _SUBTITLE_EXTS/extension regex, which already recognized .webvtt)
const webvttMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"video":{"caption_url":"https://cdn.example.com/r23/captions/en.webvtt","video_url":"https://cdn.example.com/r23/video.mp4"}}}}</script>`,
});
const webvttItem = webvttMedia.find((m) => m.url.includes('r23/captions/en.webvtt'));
assert.ok(webvttItem, 'caption_url with .webvtt extension should be recognized as a subtitle URL');

// Azure Media Player (amp) wrapper — detected via playerMimeFor MIME detection in player-config scan
const ampSmMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>window.azPlayer=amp('videoPlayer',{nativeControlsForTouch:false}); window.azPlayer.src([{src:'https://example.streaming.mediaservices.windows.net/asset.ism/manifest(format=m3u8-aapl)',type:'application/vnd.apple.mpegurl'}]);</script>`,
});
const ampHlsItem = ampSmMedia.find((m) => m.url.includes('format=m3u8-aapl'));
assert.ok(ampHlsItem, 'Azure Media Player .src() HLS source should be detected via player-config scan');

// Vidyard div-based embed
const vidyardMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<div class="vidyard-player-container" data-uuid="abcd1234efgh5678" data-type="inline"></div><script src="https://play.vidyard.com/embed/v4.js"></script>`,
});
const vidyardItem = vidyardMedia.find((m) => m.url.includes('play.vidyard.com/abcd1234efgh5678'));
assert.ok(vidyardItem, 'Vidyard div embed (class=vidyard-player-container + data-uuid) should be detected');
assert.equal(vidyardItem?.forceServerDownload, true, 'Vidyard embed should have forceServerDownload=true');

// Vidyard thumbnail img pattern
const vidyardImgMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<img src="https://play.vidyard.com/xyz99887766.jpg" style="width:100%;display:block;">`,
});
const vidyardImgItem = vidyardImgMedia.find((m) => m.url === 'https://play.vidyard.com/xyz99887766');
assert.ok(vidyardImgItem, 'Vidyard thumbnail img URL should be detected and stripped of extension');

// episode_url hydration key
const episodeMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>window.__INITIAL_STATE__={"episode":{"episode_url":"https://cdn.example.com/episodes/ep42.mp4","title":"Episode 42"}};</script>`,
});
const episodeItem = episodeMedia.find((m) => m.url.includes('ep42.mp4'));
assert.ok(episodeItem, 'episode_url hydration key should surface video URL');

// recording_url hydration key
const recordingMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"recording_url":"https://cdn.example.com/recordings/session.mp4"}}}</script>`,
});
const recordingItem = recordingMedia.find((m) => m.url.includes('session.mp4'));
assert.ok(recordingItem, 'recording_url hydration key should surface video URL');

// Bunny.net Stream iframe detection
const bunnyMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<iframe src="https://iframe.mediadelivery.net/embed/12345/abc-def-ghi" loading="lazy" allow="accelerometer"></iframe>`,
});
const bunnyItem = bunnyMedia.find((m) => m.url.includes('iframe.mediadelivery.net/embed/'));
assert.ok(bunnyItem, 'Bunny.net Stream (iframe.mediadelivery.net) should be detected');

// episode_url in player config script
const episodeConfigMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>var videoConfig={episode_url:"https://cdn.example.com/episodes/s01e03.mp4",title:"Episode 3"};</script>`,
});
const episodeConfigItem = episodeConfigMedia.find((m) => m.url.includes('s01e03.mp4'));
assert.ok(episodeConfigItem, 'episode_url in player config script should be detected');

// scanDivEmbeds: <div data-src="EMBED_URL"> pointing to known player host
const divDataSrcMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<div class="video-placeholder" data-src="https://www.youtube.com/embed/dQw4w9WgXcQ"></div>`,
});
const divDataSrcItem = divDataSrcMedia.find((m) => m.url.includes('youtube.com/embed/dQw4w9WgXcQ'));
assert.ok(divDataSrcItem, 'div data-src pointing to YouTube embed should be detected');

// scanDivEmbeds: <section data-embed-src="EMBED_URL"> for known player
const sectionEmbedSrcMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<section data-embed-src="https://player.vimeo.com/video/123456789"></section>`,
});
const sectionEmbedSrcItem = sectionEmbedSrcMedia.find((m) => m.url.includes('vimeo.com/video/123456789'));
assert.ok(sectionEmbedSrcItem, 'section data-embed-src pointing to Vimeo should be detected');

// scanDivEmbeds: data-vimeo-id attribute on generic element
const dataVimeoIdMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<div class="embed-container" data-vimeo-id="987654321"></div>`,
});
const dataVimeoIdItem = dataVimeoIdMedia.find((m) => m.url.includes('player.vimeo.com/video/987654321'));
assert.ok(dataVimeoIdItem, 'data-vimeo-id attribute should reconstruct Vimeo embed URL');

// scanDivEmbeds: data-youtube-id attribute on generic element
const dataYtIdMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<article class="story-body" data-youtube-id="AbCdEfGhIjK"></article>`,
});
const dataYtIdItem = dataYtIdMedia.find((m) => m.url.includes('youtube.com/embed/AbCdEfGhIjK'));
assert.ok(dataYtIdItem, 'data-youtube-id attribute should reconstruct YouTube embed URL');

// scanDivEmbeds: data-dailymotion-id attribute on generic element
const dataDmIdMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<figure data-dailymotion-id="x7tgd2s"></figure>`,
});
const dataDmIdItem = dataDmIdMedia.find((m) => m.url.includes('dailymotion.com/embed/video/x7tgd2s'));
assert.ok(dataDmIdItem, 'data-dailymotion-id attribute should reconstruct Dailymotion embed URL');

// Bitchute iframe embed detection
const bitchuteMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<iframe width="640" height="360" scrolling="no" frameborder="0" style="border: none;" src="https://www.bitchute.com/embed/AbCdEf123456/"></iframe>`,
});
const bitchuteItem = bitchuteMedia.find((m) => m.url.includes('bitchute.com/embed/'));
assert.ok(bitchuteItem, 'Bitchute embed iframe should be detected');

// __PLAYER_CONFIG__ global recognized as hydration script (scanHydrationData should pick it up)
const playerConfigGlobalMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>window.__PLAYER_CONFIG__={"videoUrl":"https://cdn.example.com/pconfig.mp4","poster":"https://cdn.example.com/pconfig.jpg"};</script>`,
});
const playerConfigGlobalItem = playerConfigGlobalMedia.find((m) => m.url.includes('pconfig.mp4'));
assert.ok(playerConfigGlobalItem, '__PLAYER_CONFIG__ global should be treated as hydration data');

// __MEDIA_CONFIG__ global recognized as hydration script
const mediaConfigGlobalMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>window.__MEDIA_CONFIG__={"source_url":"https://cdn.example.com/mconfig.mp4"};</script>`,
});
const mediaConfigGlobalItem = mediaConfigGlobalMedia.find((m) => m.url.includes('mconfig.mp4'));
assert.ok(mediaConfigGlobalItem, '__MEDIA_CONFIG__ global with source_url should be detected');

// mp3_url hydration key → audio MIME
const mp3UrlMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>window.__INITIAL_STATE__={"episode":{"mp3_url":"https://cdn.example.com/ep100.mp3","title":"Episode 100"}};</script>`,
});
const mp3UrlItem = mp3UrlMedia.find((m) => m.url.includes('ep100.mp3'));
assert.ok(mp3UrlItem, 'mp3_url hydration key should surface audio URL');

// podcast_url hydration key → audio
const podcastUrlMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>window.__INITIAL_STATE__={"media":{"podcast_url":"https://media.example.com/show1.mp3"}};</script>`,
});
const podcastUrlItem = podcastUrlMedia.find((m) => m.url.includes('show1.mp3'));
assert.ok(podcastUrlItem, 'podcast_url hydration key should surface audio URL');

// enclosure_url hydration key (RSS enclosure pattern)
const enclosureMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>window.__INITIAL_STATE__={"item":{"enclosure_url":"https://cdn.example.com/enclosure.mp3"}};</script>`,
});
const enclosureItem = enclosureMedia.find((m) => m.url.includes('enclosure.mp3'));
assert.ok(enclosureItem, 'enclosure_url hydration key should surface audio URL');

// Podcast RSS feed link <link rel="alternate" type="application/rss+xml">
const podcastFeedMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><head><title>My Podcast</title><link rel="alternate" type="application/rss+xml" title="My Podcast Feed" href="https://example.com/podcast.rss"></head><body><p>Episodes below</p></body></html>`,
});
const podcastFeedItem = podcastFeedMedia.find((m) => m.url.includes('podcast.rss'));
assert.ok(podcastFeedItem, 'Podcast RSS feed link should be surfaced from <link rel=alternate>');
assert.equal(podcastFeedItem?.forceServerDownload, true, 'Podcast feed URL should have forceServerDownload=true');

// <video data-hls-url="..."> lazy-load pattern
const dataHlsUrlMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<video class="player" data-hls-url="https://stream.example.com/live.m3u8" controls></video>`,
});
const dataHlsUrlItem = dataHlsUrlMedia.find((m) => m.url.includes('live.m3u8'));
assert.ok(dataHlsUrlItem, '<video data-hls-url> should be detected');

// <video data-hls-src="...">
const dataHlsSrcMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<video data-hls-src="https://cdn.example.com/playlist.m3u8" controls></video>`,
});
const dataHlsSrcItem = dataHlsSrcMedia.find((m) => m.url.includes('playlist.m3u8'));
assert.ok(dataHlsSrcItem, '<video data-hls-src> should be detected');

// <video data-mp4="..."> lazy-load pattern
const dataMp4Media = probeUniversalMedia({
  pageUrl,
  pageHtml: `<video data-mp4="https://cdn.example.com/video.mp4" poster="https://cdn.example.com/thumb.jpg"></video>`,
});
const dataMp4Item = dataMp4Media.find((m) => m.url.includes('video.mp4'));
assert.ok(dataMp4Item, '<video data-mp4> should be detected');

// data-original lazy load attribute (bLazy/Lazyload.js)
const dataOriginalMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body><img data-original="https://cdn.example.com/photo/full.jpg" src="placeholder.gif"></body></html>`,
});
const dataOriginalItem = dataOriginalMedia.find((m) => m.url.includes('photo/full.jpg'));
assert.ok(dataOriginalItem, '<img data-original> (bLazy lazy load) should be detected');

// data-original-src lazy load attribute
const dataOrigSrcMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<img data-original-src="https://cdn.example.com/gallery/hi-res.jpg">`,
});
const dataOrigSrcItem = dataOrigSrcMedia.find((m) => m.url.includes('hi-res.jpg'));
assert.ok(dataOrigSrcItem, '<img data-original-src> should be detected');

// data-lazy attribute (jQuery Lazy)
const dataLazyMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<img class="lazy" data-lazy="https://cdn.example.com/images/lazyloaded.jpg">`,
});
const dataLazyItem = dataLazyMedia.find((m) => m.url.includes('lazyloaded.jpg'));
assert.ok(dataLazyItem, '<img data-lazy> (jQuery Lazy) should be detected');

// PeerTube embed via iframe
const peertubMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<iframe src="https://peertube.example.org/videos/embed/a1b2c3d4-e5f6-7890-abcd-ef1234567890" allowfullscreen></iframe>`,
});
const peertubeItem = peertubMedia.find((m) => m.url.includes('peertube.example.org/videos/embed/'));
assert.ok(peertubeItem, 'PeerTube /videos/embed/<UUID> iframe should be detected');

// Kick.com player embed
const kickMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<iframe src="https://player.kick.com/?channel=streamerchannel" frameborder="0" allowfullscreen></iframe>`,
});
const kickItem = kickMedia.find((m) => m.url.includes('player.kick.com'));
assert.ok(kickItem, 'Kick.com player embed should be detected');

// file_url hydration key
const fileUrlMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>window.__INITIAL_STATE__={"track":{"file_url":"https://cdn.example.com/media/track.mp4","title":"Track"}};</script>`,
});
const fileUrlItem = fileUrlMedia.find((m) => m.url.includes('track.mp4'));
assert.ok(fileUrlItem, 'file_url hydration key should surface video URL');

// fileUrl in player config
const fileUrlConfigMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>var playerConfig={fileUrl:"https://cdn.example.com/media/clip.mp4",title:"Clip"};</script>`,
});
const fileUrlConfigItem = fileUrlConfigMedia.find((m) => m.url.includes('clip.mp4'));
assert.ok(fileUrlConfigItem, 'fileUrl in player config script should be detected');

// ── Round 10 tests ────────────────────────────────────────────────────────────

// <video controls> → elevated confidence (0.82 user-facing video)
const videoControlsMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body><video controls src="https://cdn.example.com/media/episode.mp4"></video></body></html>`,
});
const videoControlsItem = videoControlsMedia.find((m) => m.url.includes('episode.mp4'));
assert.ok(videoControlsItem, '<video controls> should be detected');
assert.ok((videoControlsItem?.confidence ?? 0) >= 0.82, `<video controls> confidence should be >=0.82, got ${videoControlsItem?.confidence}`);

// <video playsinline> → elevated confidence
const videoPlaysinlineMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body><video playsinline src="https://cdn.example.com/media/mobile.mp4"></video></body></html>`,
});
const videoPlaysinlineItem = videoPlaysinlineMedia.find((m) => m.url.includes('mobile.mp4'));
assert.ok(videoPlaysinlineItem, '<video playsinline> should be detected');
assert.ok((videoPlaysinlineItem?.confidence ?? 0) >= 0.82, `<video playsinline> confidence should be >=0.82, got ${videoPlaysinlineItem?.confidence}`);

// Background video (autoplay+loop+muted, no controls) → penalised confidence
const bgVideoR10Media = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body><video autoplay loop muted src="https://cdn.example.com/hero/bg-r10.mp4"></video></body></html>`,
});
const bgVideoR10Item = bgVideoR10Media.find((m) => m.url.includes('bg-r10.mp4'));
assert.ok(bgVideoR10Item, 'Background video should still be detected');
assert.ok((bgVideoR10Item?.confidence ?? 1) <= 0.56, `Background video confidence should be <=0.56, got ${bgVideoR10Item?.confidence}`);

// <iframe srcdoc> — media URL inside inline HTML should be found
const srcdocMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body><iframe srcdoc="&lt;video controls src=&quot;https://cdn.example.com/embed/srcdoc.mp4&quot;&gt;&lt;/video&gt;"></iframe></body></html>`,
});
const srcdocItem = srcdocMedia.find((m) => m.url.includes('srcdoc.mp4'));
assert.ok(srcdocItem, '<iframe srcdoc> inline video should be detected');

// video_url meta tag
const videoUrlMetaMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><head><meta name="video_url" content="https://cdn.example.com/media/meta-video.mp4"></head></html>`,
});
const videoUrlMetaItem = videoUrlMetaMedia.find((m) => m.url.includes('meta-video.mp4'));
assert.ok(videoUrlMetaItem, 'meta[name="video_url"] should be detected');

// media:url meta tag
const mediaUrlMetaMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><head><meta property="media:url" content="https://cdn.example.com/media/media-prop.mp4"></head></html>`,
});
const mediaUrlMetaItem = mediaUrlMetaMedia.find((m) => m.url.includes('media-prop.mp4'));
assert.ok(mediaUrlMetaItem, 'meta[property="media:url"] should be detected');

// __APP_CONFIG__ hydration global (using video_url key which is in field_re)
const appConfigMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>window.__APP_CONFIG__={"video_url":"https://cdn.example.com/app-config/video.mp4"};</script>`,
});
const appConfigItem = appConfigMedia.find((m) => m.url.includes('app-config/video.mp4'));
assert.ok(appConfigItem, '__APP_CONFIG__ hydration global should be detected');

// __PAGE_DATA__ hydration global (using mp4_url key)
const pageDataGlobalMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>window.__PAGE_DATA__={"mp4_url":"https://cdn.example.com/page-data/clip.mp4"};</script>`,
});
const pageDataGlobalItem = pageDataGlobalMedia.find((m) => m.url.includes('page-data/clip.mp4'));
assert.ok(pageDataGlobalItem, '__PAGE_DATA__ hydration global should be detected');

// JSON-LD with custom "videos" array key
const jsonLdVideosKeyMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script type="application/ld+json">{"@type":"ItemList","videos":[{"@type":"VideoObject","contentUrl":"https://cdn.example.com/jsonld/list-video.mp4","name":"List Video"}]}</script>`,
});
const jsonLdVideosKeyItem = jsonLdVideosKeyMedia.find((m) => m.url.includes('list-video.mp4'));
assert.ok(jsonLdVideosKeyItem, 'JSON-LD "videos" array key should be traversed');

// JSON-LD with custom "clips" key
const jsonLdClipsMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script type="application/ld+json">{"@type":"Article","clips":[{"@type":"VideoObject","contentUrl":"https://cdn.example.com/jsonld/clip.mp4","name":"Clip"}]}</script>`,
});
const jsonLdClipsItem = jsonLdClipsMedia.find((m) => m.url.includes('jsonld/clip.mp4'));
assert.ok(jsonLdClipsItem, 'JSON-LD "clips" array key should be traversed');

// ── Round 11 tests ────────────────────────────────────────────────────────────

// <mux-video playback-id="..."> → Mux CDN HLS URL
const muxVideoMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body><mux-video playback-id="DS00Spx1CV902MCtPj5WknGlR102V5HFkDe4NtXDyWoM" controls></mux-video></body></html>`,
});
const muxVideoItem = muxVideoMedia.find((m) => m.url.includes('stream.mux.com'));
assert.ok(muxVideoItem, '<mux-video playback-id> should reconstruct Mux CDN HLS URL');
assert.ok(muxVideoItem?.url.endsWith('.m3u8'), 'Mux URL should end in .m3u8');

// <mux-audio playback-id="...">
const muxAudioMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body><mux-audio playback-id="AbCdEfGhIjKlMnOp12345678" controls></mux-audio></body></html>`,
});
const muxAudioItem = muxAudioMedia.find((m) => m.url.includes('stream.mux.com'));
assert.ok(muxAudioItem, '<mux-audio playback-id> should reconstruct Mux CDN URL');

// wp_playlist recognized as hydration global
const wpPlaylistMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>var wp_playlist = [{"src":"https://cdn.example.com/wp/audio.mp3","type":"audio/mpeg","title":"Track"}];</script>`,
});
const wpPlaylistItem = wpPlaylistMedia.find((m) => m.url.includes('wp/audio.mp3'));
assert.ok(wpPlaylistItem, 'wp_playlist hydration global should surface audio URL');

// BCL (Brightcove Client Library) recognized as hydration global
const bclMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script>window.BCL = {"video":{"hls_url":"https://cdn.example.com/bcl/master.m3u8"}};</script>`,
});
const bclItem = bclMedia.find((m) => m.url.includes('bcl/master.m3u8'));
assert.ok(bclItem, 'BCL hydration global should surface video URL');

// data-brightcove JSON attribute
const brightcoveAttrMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<div data-brightcove='{"hls_url":"https://cdn.example.com/brightcove/stream.m3u8"}'></div>`,
});
const brightcoveAttrItem = brightcoveAttrMedia.find((m) => m.url.includes('brightcove/stream.m3u8'));
assert.ok(brightcoveAttrItem, 'data-brightcove JSON attribute should be scanned');

// data-embed JSON attribute (Python previously missing from NAME_RE)
const dataEmbedMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<div data-embed='{"sources":[{"src":"https://cdn.example.com/embed/video.mp4","type":"video/mp4"}]}'></div>`,
});
const dataEmbedItem = dataEmbedMedia.find((m) => m.url.includes('embed/video.mp4'));
assert.ok(dataEmbedItem, 'data-embed JSON attribute should be scanned for sources');

// ── Round 12: Plyr embed elements ──────────────────────────────────────────

// data-plyr-provider="youtube" + data-plyr-id → YouTube embed URL
const plyrYtMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body><div data-plyr-provider="youtube" data-plyr-id="dQw4w9WgXcQ"></div></body></html>`,
});
const plyrYtItem = plyrYtMedia.find((m) => m.url.includes('youtube.com/embed/dQw4w9WgXcQ'));
assert.ok(plyrYtItem, 'Plyr YouTube: data-plyr-provider=youtube should reconstruct YouTube embed URL');
assert.ok((plyrYtItem!.confidence ?? 0) >= 0.84, 'Plyr YouTube: confidence should be high');

// data-plyr-provider="vimeo" + data-plyr-id → Vimeo player URL
const plyrVimeoMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body><div data-plyr-provider="vimeo" data-plyr-id="123456789"></div></body></html>`,
});
const plyrVimeoItem = plyrVimeoMedia.find((m) => m.url.includes('player.vimeo.com/video/123456789'));
assert.ok(plyrVimeoItem, 'Plyr Vimeo: data-plyr-provider=vimeo should reconstruct Vimeo player URL');

// data-plyr-src → direct HTML5 media URL
const plyrSrcMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body><div data-plyr-provider="html5" data-plyr-src="https://cdn.example.com/plyr/video.mp4"></div></body></html>`,
});
const plyrSrcItem = plyrSrcMedia.find((m) => m.url.includes('plyr/video.mp4'));
assert.ok(plyrSrcItem, 'Plyr HTML5: data-plyr-src should surface direct media URL');

// ── Round 13: og:audio:secure_url, data-bg-video ───────────────────────────

// og:audio:secure_url meta property should be detected (was missing from regex)
const ogAudioSecureMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><head>
    <meta property="og:audio:secure_url" content="https://cdn.example.com/audio/track.mp3">
    <meta property="og:audio:type" content="audio/mpeg">
  </head><body></body></html>`,
});
const ogAudioSecureItem = ogAudioSecureMedia.find((m) => m.url.includes('audio/track.mp3'));
assert.ok(ogAudioSecureItem, 'og:audio:secure_url should be detected as audio');
assert.strictEqual(ogAudioSecureItem!.mediaKind, 'audio', 'og:audio:secure_url item should have mediaKind=audio');

// data-bg-video attribute on a div should surface the video URL
const bgVideoAttrMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <div class="hero" data-bg-video="https://cdn.example.com/bg/hero.mp4"></div>
  </body></html>`,
});
const bgVideoAttrItem = bgVideoAttrMedia.find((m) => m.url.includes('bg/hero.mp4'));
assert.ok(bgVideoAttrItem, 'data-bg-video attribute on div should surface video URL');

// data-background-video attribute variant
const bgVideoAttrMedia2 = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <section data-background-video="https://cdn.example.com/section/bg.mp4"></section>
  </body></html>`,
});
const bgVideoAttrItem2 = bgVideoAttrMedia2.find((m) => m.url.includes('section/bg.mp4'));
assert.ok(bgVideoAttrItem2, 'data-background-video attribute on section should surface video URL');

// ── Round 14: player config camelCase key parity ──────────────────────────

// hlsUrl camelCase key in inline player config script (was missing from scanPlayerConfigs)
const hlsUrlCamelMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <script>jwplayer("player").setup({ hlsUrl: "https://cdn.example.com/r14/stream.m3u8" });</script>
  </body></html>`,
});
const hlsUrlCamelItem = hlsUrlCamelMedia.find((m) => m.url.includes('r14/stream.m3u8'));
assert.ok(hlsUrlCamelItem, 'hlsUrl camelCase key in player config should be detected');

// dashUrl camelCase key in player config
const dashUrlCamelMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <script>videojs("player", { dashUrl: "https://cdn.example.com/r14/manifest.mpd" });</script>
  </body></html>`,
});
const dashUrlCamelItem = dashUrlCamelMedia.find((m) => m.url.includes('r14/manifest.mpd'));
assert.ok(dashUrlCamelItem, 'dashUrl camelCase key in player config should be detected');

// mp4Url camelCase key in player config
const mp4UrlCamelMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <script>var playerConfig = { mp4Url: "https://cdn.example.com/r14/video.mp4" };</script>
  </body></html>`,
});
const mp4UrlCamelItem = mp4UrlCamelMedia.find((m) => m.url.includes('r14/video.mp4'));
assert.ok(mp4UrlCamelItem, 'mp4Url camelCase key in player config should be detected');

// videoUrl camelCase key
const videoUrlCamelMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <script>var playerConfig = { videoUrl: "https://cdn.example.com/r14/clip.mp4" };</script>
  </body></html>`,
});
const videoUrlCamelItem = videoUrlCamelMedia.find((m) => m.url.includes('r14/clip.mp4'));
assert.ok(videoUrlCamelItem, 'videoUrl camelCase key in player config should be detected');

// ── Round 15: new embed patterns + Wistia v2 custom element ──────────────────

// <wistia-player media-id="ID"> custom element (Wistia v2)
const wistiaCEMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <wistia-player media-id="abc123xyz9"></wistia-player>
  </body></html>`,
});
const wistiaCEItem = wistiaCEMedia.find((m) => m.url.includes('abc123xyz9'));
assert.ok(wistiaCEItem, '<wistia-player media-id> should reconstruct Wistia embed URL');
assert.ok(wistiaCEItem?.url.startsWith('https://fast.wistia.com/embed/iframe/'), 'Wistia embed URL should use fast.wistia.com/embed/iframe/');

// Bandcamp EmbeddedPlayer iframe
const bandcampMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <iframe src="https://bandcamp.com/EmbeddedPlayer/album=1234567890/size=large/"></iframe>
  </body></html>`,
});
const bandcampItem = bandcampMedia.find((m) => m.url.includes('bandcamp.com/EmbeddedPlayer'));
assert.ok(bandcampItem, 'Bandcamp EmbeddedPlayer iframe should be detected as embed');

// Twitter/X embedded tweet player
const twitterEmbedMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <iframe src="https://platform.twitter.com/embed/Tweet.html?id=1234567890"></iframe>
  </body></html>`,
});
const twitterEmbedItem = twitterEmbedMedia.find((m) => m.url.includes('platform.twitter.com/embed'));
assert.ok(twitterEmbedItem, 'Twitter platform embed iframe should be detected');

// Instagram reel embed
const igEmbedMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <iframe src="https://www.instagram.com/reel/CaB123xyzXY/embed/"></iframe>
  </body></html>`,
});
const igEmbedItem = igEmbedMedia.find((m) => m.url.includes('instagram.com/reel'));
assert.ok(igEmbedItem, 'Instagram reel embed iframe should be detected');

// dai.ly short Dailymotion URL
const dailyMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <iframe src="https://dai.ly/x7abc12"></iframe>
  </body></html>`,
});
const dailyItem = dailyMedia.find((m) => m.url.includes('dai.ly'));
assert.ok(dailyItem, 'dai.ly Dailymotion short URL iframe should be detected');

// ── Round 16: Flash flashvars + extended data-attr names ─────────────────────

// Flash <object> with <param name="flashvars"> containing file= key
const flashObjMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <object type="application/x-shockwave-flash" data="player.swf">
      <param name="flashvars" value="file=https://cdn.example.com/r16/video.mp4&autostart=false"/>
    </object>
  </body></html>`,
});
const flashObjItem = flashObjMedia.find((m) => m.url.includes('r16/video.mp4'));
assert.ok(flashObjItem, 'Flash <object> flashvars file= key should surface video URL');

// Flash <embed> with flashvars attribute
const flashEmbedMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <embed type="application/x-shockwave-flash" src="player.swf" flashvars="mp4=https://cdn.example.com/r16/embed.mp4"/>
  </body></html>`,
});
const flashEmbedItem = flashEmbedMedia.find((m) => m.url.includes('r16/embed.mp4'));
assert.ok(flashEmbedItem, 'Flash <embed> flashvars mp4= key should surface video URL');

// data-flowplayer-config attribute (was not matched by old JSON_DATA_ATTR_NAME_RE)
const fpConfigMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <div data-flowplayer-config='{"clip":{"sources":[{"src":"https://cdn.example.com/r16/fp.mp4","type":"video/mp4"}]}}'></div>
  </body></html>`,
});
const fpConfigItem = fpConfigMedia.find((m) => m.url.includes('r16/fp.mp4'));
assert.ok(fpConfigItem, 'data-flowplayer-config JSON attribute should be parsed for media URLs');

// data-player-config attribute (new in Round 16 name regex)
const playerCfgMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <div data-player-config='{"source":{"src":"https://cdn.example.com/r16/player-cfg.mp4","type":"video/mp4"}}'></div>
  </body></html>`,
});
const playerCfgItem = playerCfgMedia.find((m) => m.url.includes('r16/player-cfg.mp4'));
assert.ok(playerCfgItem, 'data-player-config JSON attribute should be parsed for media URLs');

// ── Round 17: anchor media links + noscript iframe expansion ─────────────────

// Plain <a href="...mp3"> without download attr (podcast listing page pattern)
const mp3AnchorMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <ul>
      <li><a href="https://cdn.example.com/r17/episode1.mp3">Episode 1</a></li>
      <li><a href="https://cdn.example.com/r17/episode2.mp3">Episode 2</a></li>
    </ul>
  </body></html>`,
});
const mp3AnchorItem = mp3AnchorMedia.find((m) => m.url.includes('r17/episode1.mp3'));
assert.ok(mp3AnchorItem, '<a href="...mp3"> without download attr should be detected');
assert.ok(mp3AnchorMedia.find((m) => m.url.includes('r17/episode2.mp3')), 'Second MP3 anchor should also be detected');

// <a href="...mp4"> without download attr
const mp4AnchorMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <a href="https://cdn.example.com/r17/clip.mp4">Watch video</a>
  </body></html>`,
});
assert.ok(mp4AnchorMedia.find((m) => m.url.includes('r17/clip.mp4')), '<a href="...mp4"> without download should be detected');

// <noscript> wrapped YouTube iframe (blog fallback pattern)
const noscriptIframeMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <div class="video-wrapper">
      <noscript>
        <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe>
      </noscript>
    </div>
  </body></html>`,
});
const noscriptIframeItem = noscriptIframeMedia.find((m) => m.url.includes('youtube.com/embed'));
assert.ok(noscriptIframeItem, '<iframe> inside <noscript> should be detected via noscript expansion');

// <a href="...m3u8"> HLS playlist link
const hlsAnchorMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <a href="https://cdn.example.com/r17/stream.m3u8">Live stream</a>
  </body></html>`,
});
assert.ok(hlsAnchorMedia.find((m) => m.url.includes('r17/stream.m3u8')), '<a href="...m3u8"> should be detected');

// ── Round 18: extended data-attr keywords, rel="video_src", object/embed direct media ─

// data-src-hd="...mp4" — "hd" is a new keyword in isStrongDataAttribute
const hdDataAttrMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <video data-src-hd="https://cdn.example.com/r18/video-hd.mp4"></video>
  </body></html>`,
});
assert.ok(hdDataAttrMedia.find((m) => m.url.includes('r18/video-hd.mp4')), 'data-src-hd should be detected via extended mediaName keyword list');

// data-sd-src="...mp4" — "sd" is a new keyword
const sdDataAttrMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <div data-sd-src="https://cdn.example.com/r18/video-sd.mp4"></div>
  </body></html>`,
});
assert.ok(sdDataAttrMedia.find((m) => m.url.includes('r18/video-sd.mp4')), 'data-sd-src should be detected via extended mediaName keyword list');

// <link rel="video_src"> — old-style Facebook video hint
const videoSrcLinkMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><head>
    <link rel="video_src" href="https://cdn.example.com/r18/fb-video.mp4" type="video/mp4"/>
  </head></html>`,
});
assert.ok(videoSrcLinkMedia.find((m) => m.url.includes('r18/fb-video.mp4')), '<link rel="video_src"> should be detected');

// <object data="video.mp4" type="video/mp4"> — direct media embed
const objectDirectMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <object data="https://cdn.example.com/r18/object.mp4" type="video/mp4" width="640" height="360"></object>
  </body></html>`,
});
assert.ok(objectDirectMedia.find((m) => m.url.includes('r18/object.mp4')), '<object data="video.mp4" type="video/mp4"> should be detected as direct media');

// <embed src="audio.mp3" type="audio/mpeg"> — direct audio embed
const embedAudioMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <embed src="https://cdn.example.com/r18/podcast.mp3" type="audio/mpeg"/>
  </body></html>`,
});
const embedAudioItem = embedAudioMedia.find((m) => m.url.includes('r18/podcast.mp3'));
assert.ok(embedAudioItem, '<embed src="audio.mp3" type="audio/mpeg"> should be detected as direct audio');

// ── Round 19: <template> elements, WordPress Gutenberg blocks ────────────────

// <video src> inside HTML5 <template> element (Vue/Alpine/Lit template)
const templateVideoMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <template id="video-tmpl">
      <video src="https://cdn.example.com/r19/tmpl-video.mp4" controls></video>
    </template>
  </body></html>`,
});
assert.ok(templateVideoMedia.find((m) => m.url.includes('r19/tmpl-video.mp4')), '<video> inside <template> should be detected');

// data-src on <img> inside <template>
const templateImgMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<template id="img-tmpl">
    <img data-src="https://cdn.example.com/r19/tmpl-photo.jpg" alt="photo"/>
  </template>`,
});
assert.ok(templateImgMedia.find((m) => m.url.includes('r19/tmpl-photo.jpg')), 'data-src inside <template> should be detected');

// WordPress Gutenberg <!-- wp:video {"src":"..."} /--> block
const wpVideoMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<!-- wp:video {"id":123,"src":"https://cdn.example.com/r19/wp-video.mp4"} /-->
<figure class="wp-block-video">
  <video controls src="https://cdn.example.com/r19/wp-video.mp4"></video>
</figure>
<!-- /wp:video -->`,
});
assert.ok(wpVideoMedia.find((m) => m.url.includes('r19/wp-video.mp4')), 'WordPress wp:video block comment should expose video URL');

// WordPress Gutenberg <!-- wp:audio {"src":"..."} /--> block
const wpAudioMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<!-- wp:audio {"id":456,"src":"https://cdn.example.com/r19/wp-audio.mp3"} /-->`,
});
assert.ok(wpAudioMedia.find((m) => m.url.includes('r19/wp-audio.mp3')), 'WordPress wp:audio block comment should expose audio URL');

// ── Round 20: typed anchors, rel=alternate, custom media elements ────────────

// <a href="..." type="video/mp4"> without a file extension
const typedAnchorVideoMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<a href="https://cdn.example.com/r20/stream-no-ext" type="video/mp4">Watch</a>`,
});
assert.ok(typedAnchorVideoMedia.find((m) => m.url.includes('r20/stream-no-ext')), 'typed anchor video/mp4 without extension should be detected');

// <a href="..." type="audio/mpeg"> without a file extension
const typedAnchorAudioMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<a href="https://cdn.example.com/r20/podcast-no-ext" type="audio/mpeg">Listen</a>`,
});
assert.ok(typedAnchorAudioMedia.find((m) => m.url.includes('r20/podcast-no-ext')), 'typed anchor audio/mpeg without extension should be detected');

// <link rel="alternate" type="video/mp4">
const altLinkMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><head>
    <link rel="alternate" type="video/mp4" href="https://cdn.example.com/r20/alt-video.mp4"/>
  </head></html>`,
});
assert.ok(altLinkMedia.find((m) => m.url.includes('r20/alt-video.mp4')), '<link rel="alternate" type="video/mp4"> should be detected');

// <video-player src="..."> custom element
const customVideoPlayerMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<video-player src="https://cdn.example.com/r20/custom-video.mp4"></video-player>`,
});
assert.ok(customVideoPlayerMedia.find((m) => m.url.includes('r20/custom-video.mp4')), '<video-player src> custom element should be detected');

// <audio-player file="..."> custom element
const customAudioPlayerMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<audio-player file="https://cdn.example.com/r20/custom-audio.mp3"></audio-player>`,
});
assert.ok(customAudioPlayerMedia.find((m) => m.url.includes('r20/custom-audio.mp3')), '<audio-player file> custom element should be detected');

// <media-player src="..."> custom element
const customMediaPlayerMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<media-player src="https://cdn.example.com/r20/media-clip.webm"></media-player>`,
});
assert.ok(customMediaPlayerMedia.find((m) => m.url.includes('r20/media-clip.webm')), '<media-player src> custom element should be detected');

// ── Round 22: JSON-LD width/height propagation ────────────────────────────────

// JSON-LD VideoObject with plain numeric width/height
const jsonLdDimMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://cdn.example.com/r22/dim-video.mp4","name":"Dim Video","width":1920,"height":1080}</script>`,
});
const jsonLdDimItem = jsonLdDimMedia.find((m) => m.url.includes('r22/dim-video.mp4'));
assert.ok(jsonLdDimItem, 'JSON-LD VideoObject with width/height should be detected');
assert.equal(jsonLdDimItem!.width, 1920, 'JSON-LD numeric width should propagate');
assert.equal(jsonLdDimItem!.height, 1080, 'JSON-LD numeric height should propagate');

// JSON-LD VideoObject with schema.org QuantitativeValue width/height
const jsonLdQvMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://cdn.example.com/r22/qv-video.mp4","name":"QV Video","width":{"@type":"QuantitativeValue","value":1280},"height":{"@type":"QuantitativeValue","value":720}}</script>`,
});
const jsonLdQvItem = jsonLdQvMedia.find((m) => m.url.includes('r22/qv-video.mp4'));
assert.ok(jsonLdQvItem, 'JSON-LD VideoObject with QuantitativeValue width/height should be detected');
assert.equal(jsonLdQvItem!.width, 1280, 'JSON-LD QuantitativeValue width should propagate');
assert.equal(jsonLdQvItem!.height, 720, 'JSON-LD QuantitativeValue height should propagate');

// Kumu.io embed iframe (Python parity regression guard)
const kumuMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body><iframe src="https://embed.kumu.io/abc123def456"></iframe></body></html>`,
});
assert.ok(kumuMedia.find((m) => m.url.includes('embed.kumu.io/')), 'Kumu.io embed iframe should be detected');

// Podbean embed iframe (real embed URL shape: www.podbean.com/player-v2/?i=...,
// not the fictional embed.podbean.com host the regex previously required)
const podbeanMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body><iframe src="https://www.podbean.com/player-v2/?i=abc&from=pb6admin"></iframe></body></html>`,
});
assert.ok(podbeanMedia.find((m) => m.url.includes('podbean.com/player')), 'Podbean embed iframe should be detected');

// Panopto EU data-residency embed (panopto.eu, not just panopto.com)
const panoptoEuMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body><iframe src="https://university.panopto.eu/Panopto/Pages/Embed.aspx?id=VIDEO-GUID"></iframe></body></html>`,
});
assert.ok(panoptoEuMedia.find((m) => m.url.includes('panopto.eu')), 'Panopto.eu embed iframe should be detected');

// scanPlayerConfigs: bare "url" key (e.g. Plyr/Video.js sources) should be detected
const bareUrlKeyMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <script>var playerConfig={sources:[{url:"https://cdn.example.com/r22/clip.mp4",type:"video/mp4"}]};</script>
  </body></html>`,
});
assert.ok(bareUrlKeyMedia.find((m) => m.url.includes('r22/clip.mp4')), 'bare "url" key in player config should be detected');

// scanPlayerConfigs: key-name substring false positives must not match (e.g. "errorFile"
// should not be misread as the "file" key just because it ends with "file")
const noSubstringKeyMatchMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<html><body>
    <script>var playerConfig={errorFile: "https://cdn.example.com/r22/fallback-error-page", type: "video/mp4"};</script>
  </body></html>`,
});
assert.ok(!noSubstringKeyMatchMedia.some((m) => m.url.includes('r22/fallback-error-page')), 'key-name substring ("errorFile" matching "file") should not produce a false-positive candidate');

// scanJsonFeed: non-standard feed with no attachments but a direct-media external_url
// (Round 25: TS parity with Python's extract_universal_from_json_feed external_url fallback)
const jsonFeedExtUrlMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'R25 Feed',
    items: [{ id: '1', title: 'Episode 1', external_url: 'https://cdn.example.com/r25/episode1.mp3' }],
  }),
});
assert.ok(jsonFeedExtUrlMedia.find((m) => m.url.includes('r25/episode1.mp3')), 'JSON Feed external_url with direct audio extension should be detected');

const jsonFeedExtUrlPageMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'R25 Feed',
    items: [{ id: '1', title: 'Article', external_url: 'https://example.com/r25/article-page' }],
  }),
});
assert.equal(jsonFeedExtUrlPageMedia.length, 0, 'JSON Feed external_url without a direct AV extension should not be treated as media');

// data-* attribute pointing at a Smooth Streaming .ism/manifest URL should get an
// explicit DASH mimeType (Round 28: TS parity with Python's _data_attribute_protocol_hint,
// which already recognized .ism/manifest and ms-sstr in this branch)
const smoothDataAttrMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<div data-stream-url="https://example.streaming.mediaservices.windows.net/r28/asset.ism/manifest"></div>`,
});
const smoothDataAttrItem = smoothDataAttrMedia.find((m) => m.url.includes('r28/asset.ism/manifest'));
assert.ok(smoothDataAttrItem, 'Smooth Streaming .ism/manifest data attribute should be detected');
assert.equal(smoothDataAttrItem?.mimeType, 'application/dash+xml', '.ism/manifest data attribute should get an explicit DASH mimeType');

// extractPageTitle: og:title should take priority over a generic <title> tag
// (Round 32: TS parity with Python's _scan_page_title, which already preferred
// og:title/twitter:title over <title>)
const ogTitlePriorityMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<title>MySite - Home</title>
    <meta property="og:title" content="Amazing Video: How To Do X">
    <video src="https://cdn.example.com/r32/video.mp4"></video>`,
});
const ogTitlePriorityItem = ogTitlePriorityMedia.find((m) => m.url.includes('r32/video.mp4'));
assert.equal(ogTitlePriorityItem?.sourceTitle, 'Amazing Video: How To Do X', 'og:title should take priority over a generic <title> tag');

// extractPageTitle: falls back to <title> when no og:title/twitter:title is present
const titleFallbackMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<title>Fallback Title</title><video src="https://cdn.example.com/r32/fallback.mp4"></video>`,
});
const titleFallbackItem = titleFallbackMedia.find((m) => m.url.includes('r32/fallback.mp4'));
assert.equal(titleFallbackItem?.sourceTitle, 'Fallback Title', 'should fall back to <title> when no og:title/twitter:title present');

// og:video:width/height and og:image:width/height dimension metadata (Round 33:
// previously parsed neither in TS nor Python; added to both for resolution-aware ranking)
const ogVideoDimMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `
    <meta property="og:video" content="https://cdn.example.com/r33/video.mp4">
    <meta property="og:video:width" content="1920">
    <meta property="og:video:height" content="1080">
  `,
});
const ogVideoDimItem = ogVideoDimMedia.find((m) => m.url.includes('r33/video.mp4'));
assert.ok(ogVideoDimItem, 'og:video URL should be detected');
assert.equal(ogVideoDimItem!.width, 1920);
assert.equal(ogVideoDimItem!.height, 1080);

const ogImageDimMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `
    <meta property="og:image" content="https://cdn.example.com/r33/share-card.jpg">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
  `,
});
const ogImageDimItem = ogImageDimMedia.find((m) => m.url.includes('r33/share-card.jpg'));
assert.ok(ogImageDimItem, 'og:image URL should be detected');
assert.equal(ogImageDimItem!.width, 1200);
assert.equal(ogImageDimItem!.height, 630);

const ogVideoNoDimMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<meta property="og:video" content="https://cdn.example.com/r33/no-dims.mp4">`,
});
const ogVideoNoDimItem = ogVideoNoDimMedia.find((m) => m.url.includes('r33/no-dims.mp4'));
assert.ok(ogVideoNoDimItem, 'og:video URL without dimensions should still be detected');
assert.equal(ogVideoNoDimItem!.width, undefined);
assert.equal(ogVideoNoDimItem!.height, undefined);

// cleanCandidateUrl: a literal = (escaped "=") sequence inside an og:video meta
// tag's content attribute should be unescaped to a real "=" character (Round 30: TS
// parity with Python's _clean_url, which already unescaped = but cleanCandidateUrl
// only handled &). Uses an og:video meta tag rather than a player-config <script>
// field, since that field's value-capturing regex excludes raw backslashes entirely.
const escapedEqualsMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<meta property="og:video" content="https://cdn.example.com/r30/clip.mp4?id\\u003d123">`,
});
const escapedEqualsItem = escapedEqualsMedia.find((m) => m.url.includes('r30/clip.mp4'));
assert.ok(escapedEqualsItem, 'og:video URL with escaped \\u003d should be detected');
assert.ok(escapedEqualsItem!.url.includes('id=123'), `\\u003d should be unescaped to "=" in: ${escapedEqualsItem!.url}`);
assert.ok(!escapedEqualsItem!.url.includes('\\u003d'), `literal \\u003d should not remain in: ${escapedEqualsItem!.url}`);

// scanFeedContent: channel-level <itunes:image> should fill in a missing per-item thumbnail
// (Round 26: TS parity with Python's extract_universal_from_feed channel-thumbnail fallback)
const rssChannelThumbMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<?xml version="1.0"?>
  <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
    <channel>
      <title>R26 Podcast</title>
      <itunes:image href="https://cdn.example.com/r26/channel-art.jpg"/>
      <item>
        <title>Episode 1</title>
        <enclosure url="https://cdn.example.com/r26/ep1.mp3" type="audio/mpeg"/>
      </item>
    </channel>
  </rss>`,
});
const rssChannelThumbItem = rssChannelThumbMedia.find((m) => m.url.includes('r26/ep1.mp3'));
assert.ok(rssChannelThumbItem, 'RSS enclosure should be detected');
assert.equal(rssChannelThumbItem?.thumbnailUrl, 'https://cdn.example.com/r26/channel-art.jpg', 'item lacking its own thumbnail should fall back to the channel-level itunes:image');

// scanFeedContent: plain RSS <image><url> (no iTunes namespace) channel thumbnail fallback
const rssPlainImageThumbMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<?xml version="1.0"?>
  <rss version="2.0">
    <channel>
      <title>R26 Plain Podcast</title>
      <image><url>https://cdn.example.com/r26/plain-channel-art.jpg</url></image>
      <item>
        <title>Episode 1</title>
        <enclosure url="https://cdn.example.com/r26/plain-ep1.mp3" type="audio/mpeg"/>
      </item>
    </channel>
  </rss>`,
});
const rssPlainImageThumbItem = rssPlainImageThumbMedia.find((m) => m.url.includes('r26/plain-ep1.mp3'));
assert.equal(rssPlainImageThumbItem?.thumbnailUrl, 'https://cdn.example.com/r26/plain-channel-art.jpg', 'item lacking its own thumbnail should fall back to the channel-level <image><url>');

// attr(): a hyphen-prefixed attribute name (e.g. "data-tracking-src") must NOT be
// mistaken for a bare "src" attribute just because "src" appears as its suffix.
// (Round 34: \b is a word boundary, but "-" is a non-word character, so the old
// regex `\bsrc\s*=` incorrectly matched "src" inside "data-tracking-src" too —
// the fix requires the name to be preceded by whitespace or string-start instead.)
const attrSuffixCollisionMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<video data-tracking-src="https://wrong.example.com/should-not-be-picked.mp4" src="https://cdn.example.com/r34/real.mp4"></video>`,
});
// Isolate the <video> element scanner's own result via its distinct provenance —
// scanGenericUrls also independently picks up both bare .mp4-looking URLs from the
// raw text regardless of which attribute they're in, which isn't what's under test here.
const attrSuffixCollisionElementItem = attrSuffixCollisionMedia.find((m) => m.provenance === 'media-element');
assert.equal(attrSuffixCollisionElementItem?.url, 'https://cdn.example.com/r34/real.mp4', 'a "data-tracking-src" attribute must not be misread as "src" by the <video> element scanner');

// scanResourceLinks' plain-<a href> scanner has the same bug class: greedy [^>]*
// backtracking combined with a bare \b boundary could prefer a later "data-href"
// over an earlier real "href" attribute on the same tag.
const anchorHrefSuffixCollisionMedia = probeUniversalMedia({
  pageUrl,
  pageHtml: `<a href="https://cdn.example.com/r34/real.mp3" data-href="https://wrong.example.com/should-not-be-picked.mp3">Download</a>`,
});
const anchorHrefSuffixCollisionItem = anchorHrefSuffixCollisionMedia.find((m) => m.sourceAudit?.[0]?.strategy === 'media-anchor-href');
assert.equal(anchorHrefSuffixCollisionItem?.url, 'https://cdn.example.com/r34/real.mp3', 'a later "data-href" attribute must not override the real "href" on the same <a> tag');

console.log(`universal media probe ok (${media.length} candidates)`);

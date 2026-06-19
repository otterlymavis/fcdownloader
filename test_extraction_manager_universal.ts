import './test_setup.js';
import assert from 'node:assert/strict';
import { ExtractionManager, ExtractionManagerDeps } from './src/lib/extractionManager';
import { DetectedMedia } from './src/types';
import { probeUniversalMediaFromSession } from './src/lib/universalMediaProbe';
import { extractUniversalEmbedUrls, extractUniversalOEmbedUrls } from './src/lib/universalEmbedProbe';

function media(url: string, confidence = 0.9): DetectedMedia {
  return {
    id: `test_${url}`,
    url,
    pageUrl: 'https://example.com/post',
    userAgent: '',
    timestamp: Date.now(),
    mediaType: url.includes('.m3u8') ? 'hls' : 'direct',
    mediaKind: 'video',
    confidence,
  };
}

function deps(overrides: Partial<ExtractionManagerDeps> = {}): ExtractionManagerDeps {
  return {
    extractViaServer: async () => [],
    extractFromSocialUrl: async () => [],
    probeUniversalMediaFromUrl: async () => [],
    probeUniversalMediaFromSession,
    extractUniversalEmbedUrls,
    extractUniversalOEmbedUrls,
    ...overrides,
  };
}

async function testKnownSiteServerWins() {
  let browserProbeCalls = 0;
  let urlProbeCalls = 0;
  const manager = new ExtractionManager(deps({
    extractViaServer: async () => [media('https://cdn.example.com/youtube.mp4')],
    probeUniversalMediaFromSession: () => {
      browserProbeCalls += 1;
      return [media('https://cdn.example.com/browser.mp4')];
    },
    probeUniversalMediaFromUrl: async () => {
      urlProbeCalls += 1;
      return [media('https://cdn.example.com/url.mp4')];
    },
  }));

  const result = await manager.extract('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    pageHtml: '<video src="https://cdn.example.com/browser.mp4"></video>',
    mediaHints: [{ url: 'https://cdn.example.com/browser.mp4', confidence: 0.9 }],
  });

  assert.equal(result.success, true);
  assert.equal(result.strategy, 'server-extraction');
  assert.equal(result.media?.[0]?.url, 'https://cdn.example.com/youtube.mp4');
  assert.equal(browserProbeCalls, 0);
  assert.equal(urlProbeCalls, 0);
}

async function testUnknownUsesBrowserFedUniversal() {
  let urlProbeCalls = 0;
  const manager = new ExtractionManager(deps({
    probeUniversalMediaFromUrl: async () => {
      urlProbeCalls += 1;
      return [media('https://cdn.example.com/url.mp4')];
    },
  }));

  const result = await manager.extract('https://example.com/post', {
    pageHtml: '<video src="https://cdn.example.com/browser.mp4"></video>',
    mediaHints: [{ url: 'https://cdn.example.com/network/master.m3u8', kind: 'hls', confidence: 0.78 }],
  });

  assert.equal(result.success, true);
  assert.equal(result.strategy, 'universal-browser-probe');
  assert(result.media?.some((item) => item.url === 'https://cdn.example.com/browser.mp4'));
  assert(result.media?.some((item) => item.url === 'https://cdn.example.com/network/master.m3u8'));
  assert.equal(urlProbeCalls, 0);
}

async function testLowConfidenceUniversalDoesNotAutoDownload() {
  const manager = new ExtractionManager(deps());
  const result = await manager.extract('https://example.com/post', {
    mediaHints: [{ url: 'https://cdn.example.com/gallery/small.jpg', kind: 'image', confidence: 0.5 }],
  });

  assert.equal(result.success, false);
  assert.equal(result.strategy, 'none');
  assert.match(result.diagnostics?.['universal-browser-probe'] ?? '', /no media/i);
}

async function testBrowserVimeoIframeUsesDerivedConfigJson() {
  const serverCalls: string[] = [];
  const manager = new ExtractionManager(deps({
    extractViaServer: async (url) => {
      serverCalls.push(url);
      return url.includes('player.vimeo.com/video/123')
        ? [media('https://cdn.example.com/vimeo-embed.mp4')]
        : [];
    },
    probeUniversalMediaFromUrl: async () => [media('https://cdn.example.com/url.mp4')],
  }));

  const result = await manager.extract('https://example.com/post', {
    pageHtml: '<iframe src="https://player.vimeo.com/video/123"></iframe>',
  });

  assert.equal(result.success, true);
  assert.equal(result.strategy, 'universal-browser-probe');
  assert.equal(result.media?.[0]?.url, 'https://player.vimeo.com/video/123/config');
  assert.equal(result.media?.[0]?.mimeType, 'application/json');
  assert.deepEqual(serverCalls, []);
  const audit = result.media?.[0]?.sourceAudit ?? [];
  assert.equal(audit[audit.length - 1]?.strategy, 'vimeo-json');
}

async function testCanonicalVimeoPageUsesConfigWithoutServer() {
  const serverCalls: string[] = [];
  const manager = new ExtractionManager(deps({
    extractViaServer: async (url) => {
      serverCalls.push(url);
      return [];
    },
  }));

  const result = await manager.extract('https://vimeo.com/76979871');

  assert.equal(result.success, true);
  assert.equal(result.strategy, 'universal-browser-probe');
  assert.equal(result.media?.[0]?.url, 'https://player.vimeo.com/video/76979871/config');
  assert.deepEqual(serverCalls, []);
}

async function testBrowserIframeUsesPlatformFallbackWhenServerMisses() {
  let platformUrl = '';
  const manager = new ExtractionManager(deps({
    extractFromSocialUrl: async (url) => {
      platformUrl = url;
      return url.includes('youtube.com/embed/abc123')
        ? [media('https://cdn.example.com/youtube-embed.mp4')]
        : [];
    },
  }));

  const result = await manager.extract('https://example.com/post', {
    pageHtml: '<iframe src="https://www.youtube.com/embed/abc123"></iframe>',
  });

  assert.equal(result.success, true);
  assert.equal(result.strategy, 'browser-embed-platform');
  assert.equal(platformUrl, 'https://www.youtube.com/embed/abc123');
  assert.equal(result.media?.[0]?.url, 'https://cdn.example.com/youtube-embed.mp4');
}

function testEmbedProbeFindsBaseSrcdocAndObjectParamUrls() {
  const embeds = extractUniversalEmbedUrls('https://example.com/article', `
    <base href="https://www.youtube.com/">
    <iframe src="embed/abc12345678"></iframe>
    <iframe srcdoc="&lt;iframe src=&quot;https://player.vimeo.com/video/456&quot;&gt;&lt;/iframe&gt;"></iframe>
    <div data-player-url="https://cdn.jwplayer.com/players/media123-player456.html"></div>
    <object>
      <param name="movie" value="https://fast.wistia.com/embed/iframe/wistia123">
    </object>
    <iframe src="https://unknown.example.com/embed/not-supported"></iframe>
  `);

  assert.deepEqual(embeds.map((item) => item.url), [
    'https://www.youtube.com/embed/abc12345678',
    'https://player.vimeo.com/video/456',
    'https://cdn.jwplayer.com/players/media123-player456.html',
    'https://fast.wistia.com/embed/iframe/wistia123',
  ]);
  assert.equal(embeds[0]?.source, 'embed-tag');
  assert.equal(embeds[1]?.source, 'embed-srcdoc');
  assert.equal(embeds[2]?.fieldPath, 'data-player-url');
  assert.equal(embeds[3]?.source, 'object-param');
}

async function testBrowserSrcdocIframeFallsBackToEmbedServerExtraction() {
  const serverCalls: string[] = [];
  const manager = new ExtractionManager(deps({
    extractViaServer: async (url) => {
      serverCalls.push(url);
      return url.includes('fast.wistia.com/embed/iframe/456')
        ? [media('https://cdn.example.com/srcdoc-wistia.mp4')]
        : [];
    },
    probeUniversalMediaFromUrl: async () => [],
  }));

  const result = await manager.extract('https://example.com/post', {
    pageHtml: '<iframe srcdoc="&lt;iframe src=&quot;https://fast.wistia.com/embed/iframe/456&quot;&gt;&lt;/iframe&gt;"></iframe>',
  });

  assert.equal(result.success, true);
  assert.equal(result.strategy, 'browser-embed-server');
  assert.equal(result.media?.[0]?.url, 'https://cdn.example.com/srcdoc-wistia.mp4');
  assert.deepEqual(serverCalls, ['https://example.com/post', 'https://fast.wistia.com/embed/iframe/456']);
  const audit = result.media?.[0]?.sourceAudit ?? [];
  assert.equal(audit[audit.length - 1]?.source, 'embed-srcdoc');
}

async function testOEmbedProbeFetchesBoundedJsonAndExtractsIframe() {
  const fetched: string[] = [];
  const embeds = await extractUniversalOEmbedUrls('https://example.com/article/post', `
    <link rel="alternate" type="application/json+oembed" href="/oembed?url=post">
    <link rel="alternate" type="application/json+oembed" href="https://example.com/too-large-oembed">
  `, {
    maxChars: 512,
    fetchImpl: async (url, init) => {
      fetched.push(String(url));
      assert.equal((init?.headers as Record<string, string>)?.Referer, 'https://example.com/article/post');
      if (String(url).includes('too-large')) {
        return new Response('{}', { status: 200, headers: { 'Content-Length': '1024' } });
      }
      return new Response(JSON.stringify({
        html: '<iframe src="https://player.vimeo.com/video/789"></iframe>',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json+oembed', 'Content-Length': '68' },
      });
    },
  });

  assert.deepEqual(fetched, [
    'https://example.com/oembed?url=post',
    'https://example.com/too-large-oembed',
  ]);
  assert.deepEqual(embeds.map((item) => item.url), ['https://player.vimeo.com/video/789']);
  assert.equal(embeds[0]?.source, 'oembed-json');
  assert.equal(embeds[0]?.fieldPath, 'html.iframe');
}

async function testBrowserOEmbedFallsBackToEmbedServerExtraction() {
  const serverCalls: string[] = [];
  const manager = new ExtractionManager(deps({
    extractViaServer: async (url) => {
      serverCalls.push(url);
      return url.includes('player.vimeo.com/video/789')
        ? [media('https://cdn.example.com/oembed-vimeo.mp4')]
        : [];
    },
    extractUniversalOEmbedUrls: async () => [{
      url: 'https://player.vimeo.com/video/789',
      source: 'oembed-json',
      fieldPath: 'html.iframe',
    }],
    probeUniversalMediaFromUrl: async () => [],
  }));

  const result = await manager.extract('https://example.com/post', {
    pageHtml: '<link rel="alternate" type="application/json+oembed" href="/oembed?url=post">',
  });

  assert.equal(result.success, true);
  assert.equal(result.strategy, 'browser-embed-server');
  assert.equal(result.media?.[0]?.url, 'https://cdn.example.com/oembed-vimeo.mp4');
  assert.deepEqual(serverCalls, ['https://example.com/post', 'https://player.vimeo.com/video/789']);
  const audit = result.media?.[0]?.sourceAudit ?? [];
  assert.equal(audit[audit.length - 1]?.source, 'oembed-json');
  assert.equal(audit[audit.length - 1]?.fieldPath, 'html.iframe');
}

async function main() {
  await testKnownSiteServerWins();
  await testUnknownUsesBrowserFedUniversal();
  await testLowConfidenceUniversalDoesNotAutoDownload();
  await testBrowserVimeoIframeUsesDerivedConfigJson();
  await testCanonicalVimeoPageUsesConfigWithoutServer();
  await testBrowserIframeUsesPlatformFallbackWhenServerMisses();
  testEmbedProbeFindsBaseSrcdocAndObjectParamUrls();
  await testBrowserSrcdocIframeFallsBackToEmbedServerExtraction();
  await testOEmbedProbeFetchesBoundedJsonAndExtractsIframe();
  await testBrowserOEmbedFallsBackToEmbedServerExtraction();
  console.log('extraction manager universal ordering ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

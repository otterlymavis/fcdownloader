import assert from 'node:assert';
import { pickStrategy } from './src/lib/downloadStrategies';
import { extractReddit, extractRedditRssMedia } from './src/lib/platformExtractors';

const pageUrl = 'https://www.reddit.com/r/shiba/comments/1tsveql/shibas_in_the_mountains/';
const rss = `<?xml version="1.0"?>
<feed>
  <entry>
    <content type="html">&lt;a href=&quot;https://v.redd.it/0vt9aiv36h4h1&quot;&gt;video&lt;/a&gt;</content>
    <id>t3_1tsveql</id>
    <title>Shibas in the mountains</title>
  </entry>
  <entry>
    <content type="html">&lt;a href=&quot;https://preview.redd.it/comment-image.jpeg&quot;&gt;comment&lt;/a&gt;</content>
    <id>t1_comment</id>
  </entry>
</feed>`;

const video = extractRedditRssMedia(rss, pageUrl, '1tsveql');
assert.strictEqual(video.length, 1);
assert.strictEqual(video[0].url, 'https://v.redd.it/0vt9aiv36h4h1/HLSPlaylist.m3u8');
assert.strictEqual(video[0].mediaType, 'hls');
assert.strictEqual(video[0].mediaKind, 'video');
assert.deepStrictEqual(video[0].httpHeaders, { Referer: 'https://www.reddit.com/' });
assert.strictEqual(video[0].forceServerDownload, true);
assert.strictEqual(pickStrategy(video[0]), 'server-download');

const imageRss = `<?xml version="1.0"?>
<feed><entry>
  <content type="html">&lt;img src=&quot;https://preview.redd.it/post.jpeg?width=2048&amp;amp;format=pjpg&quot; /&gt;</content>
  <id>t3_image1</id>
</entry></feed>`;
const image = extractRedditRssMedia(imageRss, pageUrl, 'image1');
assert.strictEqual(image.length, 1);
assert.strictEqual(image[0].url, 'https://preview.redd.it/post.jpeg?width=2048&format=pjpg');
assert.strictEqual(image[0].mediaKind, 'image');
assert.deepStrictEqual(image[0].httpHeaders, { Referer: 'https://www.reddit.com/' });

const originalFetch = globalThis.fetch;
const requested: string[] = [];

(async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/r/shiba/s/')) {
      return {
        url: pageUrl,
        ok: true,
      } as Response;
    }
    if (url.endsWith('/.rss')) {
      return {
        ok: true,
        text: async () => rss,
      } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const extracted = await extractReddit('https://www.reddit.com/r/shiba/s/nC3HbrECzI');
    assert.strictEqual(extracted.length, 1);
    assert.strictEqual(extracted[0].url, 'https://v.redd.it/0vt9aiv36h4h1/HLSPlaylist.m3u8');
    assert.deepStrictEqual(requested, [
      'https://www.reddit.com/r/shiba/s/nC3HbrECzI',
      `${pageUrl.replace(/\/$/, '')}/.rss`,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('reddit extractor tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

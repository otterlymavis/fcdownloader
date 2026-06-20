import assert from 'node:assert';
import { extractFacebook, extractFacebookMedia } from '../src/lib/platformExtractors';

const pageUrl = 'https://www.facebook.com/watch/?v=10153231379946729';
const hdUrl = 'https:\\/\\/video.example.fbcdn.net\\/video-hd.mp4?token=abc\\u0026quality=hd';
const sdUrl = 'https:\\/\\/video.example.fbcdn.net\\/video-sd.mp4?token=def';
const html = `<script type="application/json">{
  "browser_native_sd_url":"${sdUrl}",
  "browser_native_hd_url":"${hdUrl}"
}</script>`;

const parsed = extractFacebookMedia(html, pageUrl);
assert.strictEqual(parsed.length, 1);
assert.strictEqual(parsed[0].url, 'https://video.example.fbcdn.net/video-hd.mp4?token=abc&quality=hd');
assert.strictEqual(parsed[0].label, 'Facebook HD');
assert.deepStrictEqual(parsed[0].httpHeaders, {
  'User-Agent': 'facebookexternalhit/1.1',
  Referer: 'https://www.facebook.com/',
});

const originalFetch = globalThis.fetch;
let requestInit: RequestInit | undefined;

(async () => {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestInit = init;
    return {
      ok: true,
      text: async () => html,
    } as Response;
  }) as typeof fetch;

  try {
    const extracted = await extractFacebook(pageUrl);
    assert.strictEqual(extracted.length, 1);
    const headers = requestInit?.headers as Record<string, string>;
    assert.match(headers['User-Agent'], /Chrome\/146/);
    assert.strictEqual(headers['Sec-Fetch-Mode'], 'navigate');
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('facebook extractor tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

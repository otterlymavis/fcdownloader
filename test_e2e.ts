import './test_setup.js';

const BACKEND =
  process.env.FCDOWNLOADER_BACKEND || process.env.EXPO_PUBLIC_EXTRACTOR_URL || 'https://fcdownloader-extractor.fly.dev';
process.env.EXPO_PUBLIC_EXTRACTOR_URL =
  BACKEND;

// Polyfill fetch if needed or use native fetch in node 18+
const TEST_URLS = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  'https://m.weibo.cn/status/4286822303972514',
  'https://mapp.api.weibo.cn/fx/d98fa849fa97fd2e8221047514eef64c.html',
  'http://xhslink.com/o/AuDpBCMNn0z',
  'https://www.reddit.com/r/shiba/s/nC3HbrECzI',
  'https://vm.tiktok.com/ZNR7eeRqB/',
  'https://www.tiktok.com/@nasa.tiktok2/video/7624845650504469780',
  'https://www.facebook.com/watch/?v=10153231379946729',
  'https://www.bilibili.com/video/BV1PkR2BkEUt',
  'https://vimeo.com/76979871',
  'https://www.dailymotion.com/video/xa52aa8',
  'https://www.pinterest.com/pin/84301824269690044/',
  'https://www3.nhk.or.jp/nhkworld/en/shows/2049165/',
  'https://www.oricon.co.jp/news/2285123/full/',
  'https://mdpr.jp/photo/detail/20095233',
  'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
  'https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg',
  'https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg',
  'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd'
];
const EXPECTED_BLOCKED_HOSTS = new Set(['www.reddit.com']);
const EXPECTED_DEPLOYED_DRIFT_HOSTS = new Set(['www.dailymotion.com']);

async function runTests() {
  const { extractViaServer } = await import('./src/lib/serverExtractor');
  console.log(`=== SERVER EXTRACTION (Tier 1 for all versions): ${BACKEND} ===`);
  for (const url of TEST_URLS) {
    const host = new URL(url).hostname;
    try {
      const res = await extractViaServer(url);
      console.log(`[PASS] Server - ${host} -> ${res.length} media items found.`);
    } catch (e: any) {
      const deployedDrift =
        BACKEND.includes('fcdownloader-extractor.fly.dev') && EXPECTED_DEPLOYED_DRIFT_HOSTS.has(host);
      const mark = EXPECTED_BLOCKED_HOSTS.has(host) || deployedDrift ? 'EXPECTED' : 'FAIL';
      console.log(`[${mark}] Server - ${host} -> Error: ${e.message}`);
    }
  }
}

runTests();

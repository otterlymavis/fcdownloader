import { extractFromSocialUrl } from './src/lib/platformExtractors';
import { extractViaServer } from './src/lib/serverExtractor';

// Polyfill fetch if needed or use native fetch in node 18+
const TEST_URLS = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://m.weibo.cn/status/4286822303972514',
  'http://xhslink.com/o/AuDpBCMNn0z',
  'https://www.reddit.com/r/videos/comments/18xzt8s/what_is_this_thing/',
  'https://www.tiktok.com/@tiktok/video/7106594312292453678',
  'https://www.facebook.com/watch/?v=10153231379946729',
  'https://www.bilibili.com/video/BV1GJ411x7h7/'
];

async function runTests() {
  console.log("=== SERVER EXTRACTION (Tier 1 for all versions) ===");
  for (const url of TEST_URLS) {
    try {
      const res = await extractViaServer(url);
      console.log(`[PASS] Server - ${new URL(url).hostname} -> ${res.length} media items found.`);
    } catch (e: any) {
      console.log(`[FAIL] Server - ${new URL(url).hostname} -> Error: ${e.message}`);
    }
  }
}

runTests();

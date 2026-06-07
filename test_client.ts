import { extractFromSocialUrl } from './src/lib/platformExtractors';

// Mock URLs
const URLS = {
  "YouTube": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "Twitter": "https://x.com/NASA/status/1902118174591521056",
  "Instagram": "https://www.instagram.com/p/C-h902Ttc2C/",
  "TikTok": "https://www.tiktok.com/@tiktok/video/7106594312292453678",
  "Facebook": "https://www.facebook.com/watch/?v=10153231379946729",
  "Reddit": "https://www.reddit.com/r/videos/comments/18xzt8s/what_is_this_thing/",
  "Vimeo": "https://vimeo.com/76979871",
  "Weibo": "https://m.weibo.cn/status/4286822303972514",
  "Bilibili": "https://www.bilibili.com/video/BV1GJ411x7h7/",
  "Xiaohongshu": "https://www.xiaohongshu.com/explore/654a1a5b000000001e018694",
  "Kakao TV": "https://tv.kakao.com/channel/3268481/cliplink/436329432",
  "Niconico": "https://www.nicovideo.jp/watch/1173108780",
  "TVer": "https://tver.jp/episodes/epc1hdugbk"
};

// We will mock `Platform.OS` to 'android' to test the client-fallback path.
// When Platform.OS is android, `fetch` will not have CORS restrictions in the real app.
// In Node.js, `fetch` naturally has no CORS restrictions, perfectly simulating Android/iOS/Extension!

async function runClientTests() {
  console.log("Testing Client-Side Fallback (Simulating Android/iOS/Extension)...");
  
  // Disable backend so it falls back immediately
  process.env.EXPO_PUBLIC_EXTRACTOR_URL = "http://localhost:9999/down";

  for (const [name, url] of Object.entries(URLS)) {
    try {
      const media = await extractFromSocialUrl(url);
      if (media && media.length > 0) {
        console.log(`[PASS] ${name} -> Found ${media.length} items (via local fallback)`);
      } else {
        console.log(`[FAIL] ${name} -> No media found`);
      }
    } catch (e: any) {
      console.log(`[FAIL] ${name} -> Error: ${e.message}`);
    }
  }
}

runClientTests();

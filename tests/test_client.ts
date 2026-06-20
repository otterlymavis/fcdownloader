import './test_setup.js';

// Mock URLs
const URLS = {
  "YouTube": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "YouTube First Video": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  "Twitter": "https://x.com/NASA/status/1902118174591521056",
  "Instagram Reel": "https://www.instagram.com/reel/C7VgIvhsKgR/",
  "TikTok Short": "https://vm.tiktok.com/ZNR7eeRqB/",
  "TikTok NASA": "https://www.tiktok.com/@nasa.tiktok2/video/7624845650504469780",
  "Facebook": "https://www.facebook.com/watch/?v=10153231379946729",
  "Reddit Gallery": "https://www.reddit.com/r/shiba/s/nC3HbrECzI",
  "Vimeo": "https://vimeo.com/76979871",
  "Dailymotion": "https://www.dailymotion.com/video/xa52aa8",
  "Pinterest": "https://www.pinterest.com/pin/84301824269690044/",
  "Weibo": "https://m.weibo.cn/status/4286822303972514",
  "Weibo Share": "https://mapp.api.weibo.cn/fx/d98fa849fa97fd2e8221047514eef64c.html",
  "Bilibili": "https://www.bilibili.com/video/BV1PkR2BkEUt",
  "Xiaohongshu": "https://www.xiaohongshu.com/explore/654a1a5b000000001e018694",
  "Kakao TV": "https://tv.kakao.com/channel/3268481/cliplink/436329432",
  "Niconico": "https://www.nicovideo.jp/watch/1173108780",
  "TVer": "https://tver.jp/episodes/epc1hdugbk",
  "NHK World": "https://www3.nhk.or.jp/nhkworld/en/shows/2049165/",
  "Oricon": "https://www.oricon.co.jp/news/2285123/full/",
  "Modelpress": "https://mdpr.jp/photo/detail/20095233",
  "Direct MP4": "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
  "Direct Image": "https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg",
  "Direct Audio": "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg",
  "HLS Manifest": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
  "DASH Manifest": "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd"
};

// We will mock `Platform.OS` to 'android' to test the client-fallback path.
// When Platform.OS is android, `fetch` will not have CORS restrictions in the real app.
// In Node.js, `fetch` naturally has no CORS restrictions, perfectly simulating Android/iOS/Extension!

async function runClientTests() {
  // Disable backend so it falls back immediately
  process.env.EXPO_PUBLIC_EXTRACTOR_URL = "http://localhost:9999/down";
  const { extractFromSocialUrl } = await import('../src/lib/platformExtractors');
  console.log("Testing Client-Side Fallback (Simulating Android/iOS/Extension)...");

  const expectedNoFallback = new Set([
    'Weibo',
    'Weibo Share',
    'Kakao TV',
    'TVer',
    'Direct MP4',
    'Direct Image',
    'Direct Audio',
    'HLS Manifest',
    'DASH Manifest',
  ]);

  for (const [name, url] of Object.entries(URLS)) {
    try {
      const media = await extractFromSocialUrl(url);
      if (media && media.length > 0) {
        console.log(`[PASS] ${name} -> Found ${media.length} items (via local fallback)`);
      } else if (expectedNoFallback.has(name)) {
        console.log(`[EXPECTED] ${name} -> No client-side social fallback`);
      } else {
        console.log(`[FAIL] ${name} -> No media found`);
      }
    } catch (e: any) {
      console.log(`[FAIL] ${name} -> Error: ${e.message}`);
    }
  }
}

runClientTests();

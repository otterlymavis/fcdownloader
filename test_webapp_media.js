const fetch = globalThis.fetch || (() => { try { return require('node-fetch'); } catch(e) { return null; } })();
if (!fetch) { console.error("Error: fetch is not available in your Node.js environment."); process.exit(1); }

const BACKEND = (process.env.FCDOWNLOADER_BACKEND || "https://fcdownloader-extractor.fly.dev").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = Number(process.env.FCDOWNLOADER_TEST_TIMEOUT_MS || 5000);
const LIMIT = Number(process.env.FCDOWNLOADER_TEST_LIMIT || 10);

const URLS = {
  // ── Global / Social ───────────────────────────────────────────────────
  "YouTube":       "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "YouTube-zoo":   "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  "TikTok":        "https://vm.tiktok.com/ZNR7eeRqB/",
  "TikTok-NASA":   "https://www.tiktok.com/@nasa.tiktok2/video/7624845650504469780",
  "Instagram":     "https://www.instagram.com/reel/C7VgIvhsKgR/",
  "Threads":       "https://www.threads.net/@instagram/post/CuZsgc9vQ0M",
  "Twitter/X":     "https://x.com/NASA/status/1902118174591521056",
  "Facebook":      "https://www.facebook.com/watch/?v=10153231379946729",
  "Reddit":        "https://www.reddit.com/r/shiba/s/nC3HbrECzI",
  "Pinterest":     "https://www.pinterest.com/pin/84301824269690044/",
  "Vimeo":         "https://vimeo.com/76979871",
  "Dailymotion":   "https://www.dailymotion.com/video/xa52aa8",
  "Direct MP4":    "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
  "Direct Image":  "https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg",
  "Direct Audio":  "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg",
  "HLS Manifest":  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
  "DASH Manifest": "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd",
  // ── Chinese ───────────────────────────────────────────────────────────
  "Bilibili":      "https://www.bilibili.com/video/BV1PkR2BkEUt",
  "Bilibili-large":"https://www.bilibili.com/video/BV1ux411U7Dp/",
  "Bilibili dynamic / opus": "https://www.bilibili.com/opus/475137916835860645",
  "Weibo":         "https://mapp.api.weibo.cn/fx/d98fa849fa97fd2e8221047514eef64c.html",
  "Xiaohongshu":   "http://xhslink.com/o/AuDpBCMNn0z",
  "Douyin":        "https://www.douyin.com/video/6918273131559881997",
  // ── Japanese / Korean Video & Streaming ──────────────────────────────
  "NicoNico":      "https://www.nicovideo.jp/watch/sm17517479",
  "TVer":          "https://tver.jp/episodes/epc1hdugbk",
  "ABEMA":         "https://abema.tv/video/episode/194-25_s2_p1",
  "NHK":           "https://www3.nhk.or.jp/nhkworld/en/shows/2049165/",
  "TwitCasting":   "https://twitcasting.tv/ivetesangalo/movie/2357609",
  "FC2 Video":     "http://video.fc2.com/en/content/20121103kUan1KHs",
  "FC2 Live":      "https://live.fc2.com/57892267/",
  "OpenREC":       "https://www.openrec.tv/movie/nqz5xl5km8v",
  "TBS":           "https://www.tbs.com/shows/american-dad/season-6/episode-12/you-debt-your-life",
  "FOD / Fuji TV": "https://fod.fujitv.co.jp/title/5d40/5d40110076",
  "Naver TV":      "http://tv.naver.com/v/81652",
  "Kakao TV":      "http://tv.kakao.com/channel/2671005/cliplink/301965083",
  "Yahoo Japan video/news": "https://news.yahoo.co.jp/articles/a70fe3a064f1cfec937e2252c7fc6c1ba3201c0e",
  "DMM":           "https://www.dmm.co.jp/mono/dvd/-/detail/=/cid=3841h_015/",
  // ── Japanese / Korean News, Magazines, Blogs & Galleries ─────────────
  "Oricon":        "https://www.oricon.co.jp/news/2285123/full/",
  "Modelpress":    "https://mdpr.jp/photo/detail/20095233",
  "Natalie":       "https://natalie.mu/music/news/670767",
  "Naver Blog":    "https://blog.naver.com/jalee3228/224297926556",
  "Naver News":    "https://news.naver.com/election/region2026",
  "Naver Entertainment": "https://entertain.naver.com/read?oid=108&aid=0003257812",
  "Naver Sports":  "https://sports.news.naver.com/kbaseball/news/read?oid=241&aid=0003450000",
  "Ameblo":        "https://ameblo.jp/chunta-2011/",
  "Kstyle":        "https://kstyle.com/topicNews.ksn?topicNo=1107",
  "Daum / Tistory": "https://storymarketer.tistory.com/m/entry/%EB%B8%94%EB%A1%9C%EA%B7%B8-%EB%A7%88%EC%BC%80%ED%8C%85-%EC%95%84%EC%A7%81-%ED%9A%A8%EA%B3%BC-%EC%9E%88%EC%9D%84%EA%B9%8C",
  "Livedoor Blog": "http://blog.livedoor.jp/new_alces/archives/4980902.html",
  "Yahoo Japan articles": "https://news.yahoo.co.jp/articles/20ed9737a7a5411fbd2456f7df836fca68579d2f",
  "Pixiv / Fanbox": "https://www.pixiv.net/artworks/100000000",
  "Bunshun":       "https://bunshun.jp/articles/photo/88467",
  "Daily Shincho": "https://www.dailyshincho.jp/article/",
  "News Post Seven / Josei Seven": "https://www.news-postseven.com/news",
  "FRIDAY":        "https://friday.kodansha.co.jp/article/469626",
  "Gendai Media":  "https://gendai.media/articles/-/167825",
  "With":          "https://withonline.jp/with-class/education/mamacolumn/SQMdi",
  "ViVi":          "https://www.vivi.tv/post480665/",
  "CanCam":        "https://cancam.jp/archives/category/fashion/item",
  "CLASSY":        "https://classy-online.jp/fashion/jewelry-watch/",
  "JJ":            "https://jj-jj.net/fashion/fashion_category/fashion-news/",
  "Ginger":        "https://gingerweb.jp/timeless/person/20260531-taisei_kido-4",
  "ar":            "https://ar-mag.jp/articles/-/19822",
  "bis":           "https://bisweb.jp/category/column",
  "Ray":           "https://ray-web.jp/531989",
  "HP+ non-no":    "https://nonno.hpplus.jp/fashion/watches/",
  "HP+ SPUR":      "https://spur.hpplus.jp/jewelry_watch/",
  "HP+ MAQUIA":    "https://maquia.hpplus.jp/tag/3259/",
  "HP+ LEE":       "https://lee.hpplus.jp/column/",
  "HP+ BAILA":     "https://baila.hpplus.jp/fashion/watch-jewerly",
  "ananweb":       "https://ananweb.jp/categories/horoscope/76522",
  "Croissant Online": "https://croissant-online.jp/life/273608/",
  "FRaU":          "https://frau.tokyo/list/tag/frau/SPORTS",
  "mi-mollet":     "https://mi-mollet.com/ud/article_photo/search",
  "Fashion Press": "https://www.fashion-press.net/news/",
  "Fashionsnap":   "https://www.fashionsnap.com/article/2026-06-03/nakagawa-masashichi-shitsurindo/?ref=simple-news-click",
  "WWD Japan":     "https://www.wwdjapan.com/s/505009",
  "thetv.jp":      "https://thetv.jp/news/detail/1401412/",
  "Mantan Web":    "https://mantan-web.jp/article/20240401dog00m200001000c.html",
  "Crank In":      "https://www.crank-in.net/news/186258",
  "CinemaToday":   "https://www.cinematoday.jp/news/N0153809",
  "eiga.com":      "https://eiga.com/news/20260522/23/",
  "Real Sound":    "https://realsound.jp/movie/2026/05/post-2406453.html?utm_source=rs-pickup-pc&utm_medium=all&utm_campaign=block-1",
  "Spice":         "https://spice.eplus.jp/articles/346378",
  "JPrime":        "https://www.jprime.jp/list/tag/NEWS",
  "Smart Flash":   "https://smart-flash.jp/entertainment/",
  "Nikkan Gendai": "https://www.nikkan-gendai.com/articles/index/news",
  "Asagei":        "https://www.asagei.com/category/sports",
  "Entame Next":   "https://entamenext.com/category/lists/news",
  "GirlsNews":     "https://girlsnews.tv/category/news",
  "Tokyo Sports":  "https://www.tokyo-sports.co.jp/list/sports",
  "Hochi":         "https://hochi.news/photos/",
  "Sponichi":      "https://www.sponichi.co.jp/soccer/tokusyu/wc2026/?from=glonavi",
  "Nikkan Sports": "https://www.nikkansports.com/baseball/samurai/wbc2026/",
  "Sanspo":        "https://www.sanspo.com/sports/baseball/mlb/",
  "Mainichi":      "https://mainichi.jp/ch150910144i/%E9%A6%96%E7%9B%B8%E6%97%A5%E3%80%85",
  "Asahi":         "http://www.asahi.com/news/",
  "Yomiuri":       "https://www.yomiuri.co.jp/news/",
  "Sankei":        "https://www.sankei.com/sports/",
  "Tokyo Shimbun": "https://www.tokyo-np.co.jp/special_contents/special_frontline/honne_column?ref=gnb_pc",
  "Kyodo":         "https://www.kyodo.co.jp/news",
  "47News":        "https://www.47news.jp/topic/today0603",
  "Jiji":          "https://www.jiji.com/jc/2026syu",
  "ITmedia":       "https://www.itmedia.co.jp/news/articles/2606/03/news138.html",
  "Impress / Watch": "https://www.watch.impress.co.jp/category/life/watch/",
  "Mynavi News":   "https://news.mynavi.jp/techplus/",
  "ASCII":         "https://ascii.jp/puacl2026/",
  "Gigazine":      "https://gigazine.net/gsc_news/en/",
};

async function testBackend() {
  console.log(`--- TESTING BACKEND FOR WEB APP: ${BACKEND} ---`);
  const entries = Number.isFinite(LIMIT) && LIMIT > 0
    ? Object.entries(URLS).slice(0, LIMIT)
    : Object.entries(URLS);
  if (entries.length < Object.keys(URLS).length) {
    console.log(`--- Limited to ${entries.length} URLs. Set FCDOWNLOADER_TEST_LIMIT=0 for the full sweep. ---`);
  }
  for (const [name, url] of entries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${BACKEND}/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageUrl: url }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text();
        console.log(`[${name}] -> FAIL (HTTP ${res.status}):`, body.length > 500 ? `${body.slice(0, 500)}...` : body);
      } else {
        const data = await res.json();
        let urlStr = data.url || data.videoUrl || "";
        let headers = data.headers || {};
        if (data.kind === "gallery") {
            const firstItem = data.items[0];
            urlStr = firstItem ? (firstItem.url || firstItem.videoUrl) : "";
            headers = firstItem ? firstItem.headers : {};
        }

        if (urlStr) {
            try {
                // Probe the media URL
                const mediaRes = await fetch(urlStr, {
                    method: 'GET',
                    headers: { ...headers, "Range": "bytes=0-2047" },
                    signal: controller.signal
                });
                
                if (mediaRes.ok || mediaRes.status === 206) {
                    const ctype = mediaRes.headers.get("content-type");
                    const clen = mediaRes.headers.get("content-length") || mediaRes.headers.get("content-range");
                    console.log(`[${name}] -> SUCCESS (Media Downloadable: ${ctype}, size/range: ${clen})`);
                } else {
                    console.log(`[${name}] -> FAIL (Media Probe ${mediaRes.status}: ${urlStr.substring(0, 40)}...)`);
                }
            } catch (mediaErr) {
                console.log(`[${name}] -> FAIL (Media Probe Error: ${mediaErr.message})`);
            }
        } else {
            console.log(`[${name}] -> SUCCESS (Metadata only: ${JSON.stringify(data).substring(0, 80)}...)`);
        }
      }
    } catch (e) {
      console.log(`[${name}] -> ERROR:`, e.message);
    } finally {
      clearTimeout(timer);
    }
  }
}

testBackend();

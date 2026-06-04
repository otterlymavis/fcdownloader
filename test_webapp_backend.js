const fetch = globalThis.fetch || (() => { try { return require('node-fetch'); } catch(e) { return null; } })();
if (!fetch) { console.error("Error: fetch is not available in your Node.js environment."); process.exit(1); }


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
  // ── Chinese ───────────────────────────────────────────────────────────
  "Bilibili":      "https://www.bilibili.com/video/BV1PkR2BkEUt",
  "Bilibili-large":"https://www.bilibili.com/video/BV1ux411U7Dp/",
  "Bilibili dynamic / opus": "https://t.bilibili.com/998134289197432852",
  "Weibo":         "https://mapp.api.weibo.cn/fx/d98fa849fa97fd2e8221047514eef64c.html",
  "Xiaohongshu":   "http://xhslink.com/o/AuDpBCMNn0z",
  "Douyin":        "https://www.douyin.com/video/7212345678901234567",
  // ── Japanese / Korean Video & Streaming ──────────────────────────────
  "NicoNico":      "https://www.nicovideo.jp/watch/sm17517479",
  "TVer":          "https://tver.jp/episodes/ep1orpabaq",
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
  "DMM":           "https://www.dmm.co.jp/digital/video/-/detail/=/cid=13ds00645/",
  "Mildom":        "https://www.mildom.com/playback/10105254/20200824",
  // ── Japanese / Korean News, Magazines, Blogs & Galleries ─────────────
  "Oricon":        "https://www.oricon.co.jp/news/2452025/photo/1/",
  "Modelpress":    "https://mdpr.jp/photo/detail/20095233",
  "Natalie":       "https://natalie.mu/music/news/670767",
  "Naver Blog":    "https://blog.naver.com/jalee3228/224297926556",
  "Naver News":    "https://news.naver.com/election/region2026",
  "Naver Entertainment": "https://entertain.naver.com/now",
  "Naver Sports":  "https://sports.news.naver.com/news/read?oid=001&aid=0012345678",
  "Ameblo":        "https://ameblo.jp/chunta-2011/",
  "Kstyle":        "https://kstyle.com/topicNews.ksn?topicNo=1107",
  "Daum / Tistory": "https://storymarketer.tistory.com/entry/%EB%B8%94%EB%A1%9C%EA%B7%B8-%EB%A7%88%EC%BC%80%ED%8C%85-%EC%95%84%EC%A7%81-%ED%9A%A8%EA%B3%BC-%EC%9E%88%EC%9D%84%EA%B9%8C",
  "Livedoor Blog": "http://blog.livedoor.jp/new_alces/archives/4980902.html",
  "Yahoo Japan articles": "https://news.yahoo.co.jp/articles/20ed9737a7a5411fbd2456f7df836fca68579d2f",
  "Pixiv / Fanbox": "https://www.pixiv.net/artworks/100000000",
  "Bunshun":       "https://bunshun.jp/articles/photo/88467",
  "Daily Shincho": "https://www.dailyshincho.jp/article/",
  "News Post Seven / Josei Seven": "https://www.news-postseven.com/news",
  "FRIDAY":        "https://friday.kodansha.co.jp/article/469626",
  "Gendai Media":  "https://gendai.media/articles/-/167825",
  "With":          "https://withonline.jp/with-class/education/mamacolumn/SQMdi",
  "ViVi":          "https://www.vivi.tv/wp-json/wp/v2/pages/8913",
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
  "Croissant Online": "https://croissant-online.jp/wp-content/themes/croissant2024/manifest.webmanifest",
  "FRaU":          "https://frau.tokyo/list/tag/frau/SPORTS",
  "mi-mollet":     "https://mi-mollet.com/ud/article_photo/search",
  "Fashion Press": "https://www.fashion-press.net/news/",
  "Fashionsnap":   "https://www.fashionsnap.com/article/2026-06-03/nakagawa-masashichi-shitsurindo/?ref=simple-news-click",
  "WWD Japan":     "https://www.wwdjapan.com/s/505009",
  "thetv.jp":      "https://thetv.jp/news/detail/1401412/",
  "Mantan Web":    "https://mantan-web.jp/article/20240401dog00m200001000c.html",
  "Crank In":      "https://www.crank-in.net/news",
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
  "Mynavi News":   "https://news.mynavi.jp/techplus/list/headline/whitepaper/article_type/case/",
  "ASCII":         "https://ascii.jp/puacl2026/",
  "Gigazine":      "https://gigazine.net/gsc_news/en/",
};

async function testBackend() {
  console.log("--- TESTING DEPLOYED BACKEND FOR WEB APP ---");
  for (const [name, url] of Object.entries(URLS)) {
    try {
      const res = await fetch("https://fcdownloader-extractor.fly.dev/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageUrl: url })
      });
      if (!res.ok) {
        console.log(`[${name}] -> FAIL (HTTP ${res.status}):`, await res.text());
      } else {
        const data = await res.json();
        const urlStr = data.url || data.videoUrl || "";
        if (data.kind === "gallery") {
            console.log(`[${name}] -> SUCCESS (Gallery with ${data.items.length} images)`);
        } else if (urlStr) {
            console.log(`[${name}] -> SUCCESS (${urlStr.substring(0, 40)}...)`);
        } else {
            console.log(`[${name}] -> SUCCESS (Metadata: ${JSON.stringify(data).substring(0, 80)}...)`);
        }
      }
    } catch (e) {
      console.log(`[${name}] -> ERROR:`, e.message);
    }
  }
}

testBackend();

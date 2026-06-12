const puppeteer = require('puppeteer');
const fs = require('fs');

const domains_to_fetch = {
    "TVer": { url: "https://tver.jp/", selector: 'a[href^="/episodes/"]' },
    "TBS": { url: "https://cu.tbs.co.jp/", selector: 'a[href^="/episode/"]' },
    "FOD / Fuji TV": { url: "https://fod.fujitv.co.jp/", selector: 'a[href^="/title/"]' },
    "Nippon TV VOD": { url: "https://vod.ntv.co.jp/", selector: 'a[href^="/program/"]' },
    "Yahoo Japan video/news": { url: "https://news.yahoo.co.jp/video", selector: 'a[href*="/articles/"]' },
    "Yahoo Japan articles": { url: "https://news.yahoo.co.jp/", selector: 'a[href*="/articles/"]' },
    "ITmedia": { url: "https://www.itmedia.co.jp/", selector: 'a[href$=".html"]' },
    "Bunshun": { url: "https://bunshun.jp/", selector: 'a[href^="/articles/-/"]' },
    "Gendai Media": { url: "https://gendai.media/", selector: 'a[href^="/articles/-/"]' },
    "eiga.com": { url: "https://eiga.com/news/", selector: 'a[href^="/news/202"]' },
    "Entame Next": { url: "https://entamenext.com/", selector: 'a[href^="/articles/detail/"]' },
    "Asahi": { url: "https://www.asahi.com/video/", selector: 'a[href^="/articles/"]' },
    "Mantan Web": { url: "https://mantan-web.jp/", selector: 'a[href^="/article/"]' },
    "Fashion Press": { url: "https://www.fashion-press.net/", selector: 'a[href^="/news/"]' },
    "FRaU": { url: "https://frau.tokyo/", selector: 'a[href^="/article/detail/"]' },
    "Croissant Online": { url: "https://croissant-online.jp/", selector: 'a[href^="https://croissant-online.jp/"]' },
    "Oricon": { url: "https://www.oricon.co.jp/news/", selector: 'a[href^="/news/"]' },
    "Bilibili-large": { url: "https://www.bilibili.com/", selector: 'a[href*="/video/BV"]' },
    "Weibo": { url: "https://m.weibo.cn/", selector: 'a[href^="/detail/"]' },
    "Douyin": { url: "https://www.douyin.com/", selector: 'a[href*="/video/"]' },
    "NicoNico": { url: "https://www.nicovideo.jp/", selector: 'a[href*="watch/sm"]' },
    "TwitCasting": { url: "https://twitcasting.tv/", selector: 'a[href*="/movie/"]' },
    "FC2 Video": { url: "https://video.fc2.com/", selector: 'a[href^="/content/"]' },
    "OpenREC": { url: "https://www.openrec.tv/", selector: 'a[href^="/live/"]' },
    "Naver TV": { url: "https://tv.naver.com/", selector: 'a[href^="/v/"]' },
    "Kakao TV": { url: "https://tv.kakao.com/", selector: 'a[href*="/cliplink/"]' },
};

(async () => {
    console.log("Launching Puppeteer...");
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const results = {};

    for (const [name, info] of Object.entries(domains_to_fetch)) {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        try {
            console.log(`Fetching ${name} from ${info.url}...`);
            await page.goto(info.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await new Promise(r => setTimeout(r, 2000)); // Wait for SPAs to render

            const link = await page.evaluate((selector) => {
                const els = document.querySelectorAll(selector);
                for (let el of els) {
                    const href = el.href;
                    if (href && href.length > 10 && !href.endsWith('.css') && !href.endsWith('.js')) {
                        return href;
                    }
                }
                return null;
            }, info.selector);

            if (link) {
                results[name] = link;
                console.log(`✅ ${name}: ${link}`);
            } else {
                console.log(`❌ ${name}: No matches found`);
            }
        } catch (e) {
            console.log(`⚠️ ${name}: Error - ${e.message}`);
        } finally {
            await page.close();
        }
    }

    await browser.close();
    
    console.log("\\n--- Summary ---");
    console.log(`Successfully fetched ${Object.keys(results).length} URLs`);
    fs.writeFileSync('fresh_urls.json', JSON.stringify(results, null, 2));
})();

const fetch = require('node-fetch') || globalThis.fetch;

const URLS = {
  "TikTok": "https://vm.tiktok.com/ZNR7eeRqB/",
  "Reddit": "https://www.reddit.com/r/shiba/s/nC3HbrECzI",
  "Bilibili": "https://www.bilibili.com/video/BV1PkR2BkEUt",
  "Xiaohongshu": "http://xhslink.com/o/AuDpBCMNn0z",
  "Weibo": "https://mapp.api.weibo.cn/fx/d98fa849fa97fd2e8221047514eef64c.html"
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
        if (data.kind === "gallery") {
            console.log(`[${name}] -> SUCCESS (Gallery with ${data.items.length} images)`);
        } else {
            console.log(`[${name}] -> SUCCESS (${data.url.substring(0, 40)}...)`);
        }
      }
    } catch (e) {
      console.log(`[${name}] -> ERROR:`, e.message);
    }
  }
}

testBackend();

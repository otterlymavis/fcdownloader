const fetch = require('node-fetch') || globalThis.fetch;

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'en-US,en;q=0.9' } });
  return res.text();
}

async function extractTikTok(pageUrl) {
  let url = pageUrl;
  if (url.includes('vm.tiktok.com') || url.includes('vt.tiktok.com')) {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
    url = res.url;
  }
  const m = url.match(/(?:video|photo|v)\/(\d+)/);
  if (!m) return null;
  const videoId = m[1];
  const res = await fetch(`https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}`, {
    headers: { 'User-Agent': MOBILE_UA }
  });
  try {
    const data = await res.json();
    const aweme = data.aweme_list?.[0];
    if (aweme?.video?.play_addr?.url_list?.length > 0) {
      return `TikTok Video Found: ${aweme.video.play_addr.url_list[0].slice(0, 50)}...`;
    } else if (aweme?.image_post_info?.images) {
      return `TikTok Photo Gallery Found: ${aweme.image_post_info.images.length} images`;
    }
  } catch (e) {
    return `TikTok Failed JSON: ${e.message}`;
  }
  return null;
}

async function extractReddit(pageUrl) {
  let url = pageUrl;
  if (url.includes('/s/')) {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
    url = res.url;
  }
  const jsonUrl = url.split('?')[0].replace(/\/$/, '') + '/.json';
  const res = await fetch(jsonUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!res.ok) return `Reddit failed: ${res.status}`;
  const data = await res.json();
  const post = data[0]?.data?.children?.[0]?.data;
  if (post?.secure_media?.reddit_video?.fallback_url) {
    return `Reddit Video Found: ${post.secure_media.reddit_video.fallback_url.slice(0, 50)}...`;
  }
  return null;
}

async function extractBilibili(pageUrl) {
  const html = await fetchHtml(pageUrl);
  const m = html.match(/window\.__playinfo__\s*=\s*(\{.*?\})<\/script>/);
  if (m) {
    const data = JSON.parse(m[1]);
    if (data?.data?.durl?.[0]?.url) {
      return `Bilibili Video Found: ${data.data.durl[0].url.slice(0, 50)}...`;
    }
  }
  const m2 = html.match(/"readyVideoUrl"\s*:\s*"([^"]+)"/);
  if (m2) {
    return `Bilibili Video Found: ${m2[1].replace(/\\\//g, '/').slice(0, 50)}...`;
  }
  return null;
}

async function extractXiaohongshu(pageUrl) {
  let url = pageUrl;
  if (pageUrl.includes('xhslink.com')) {
    const res = await fetch(pageUrl, { headers: { 'User-Agent': MOBILE_UA }, redirect: 'follow' });
    url = res.url;
  }
  const html = await fetchHtml(url);
  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*<\/script>/);
  if (m) {
    const stateStr = m[1].replace(/undefined/g, 'null');
    const data = JSON.parse(stateStr);
    const noteId = data.note?.currentNoteId || Object.keys(data.note?.noteDetailMap || {})[0];
    const note = data.note?.noteDetailMap?.[noteId]?.note;
    if (note?.video?.media?.stream?.h264?.[0]?.masterUrl) {
      return `XHS Video Found: ${note.video.media.stream.h264[0].masterUrl.slice(0, 50)}...`;
    } else if (note?.imageList?.length > 0) {
      return `XHS Image Gallery Found: ${note.imageList.length} images`;
    }
  }
  return null;
}

async function extractWeibo(pageUrl) {
  let url = pageUrl;
  if (url.includes('mapp.api.weibo.cn')) {
    const res = await fetch(url, { headers: { 'User-Agent': MOBILE_UA }, redirect: 'follow' });
    url = res.url;
  }
  const html = await fetchHtml(url);
  
  // Try render_data
  const renderDataMatch = html.match(/window\.\$render_data\s*=\s*(\[[\s\S]+?\])\[0\]/);
  if (renderDataMatch) {
    const data = JSON.parse(renderDataMatch[1])[0];
    const pics = data?.status?.pics || data?.pics;
    if (Array.isArray(pics)) {
      return `Weibo Images Found: ${pics.length}`;
    }
  }
  
  // Generic Regex
  const urls = [];
  const re = /(https?:\\?\/\\?\/[^"'\\<>\s]*(?:weibocdn\.com|sinaimg\.cn)[^"'\\<>\s]*\.(?:mp4|m3u8|mov|jpe?g|png|webp|gif|heic)[^"'\\<>\s]*)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    urls.push(m[1].replace(/\\/g, ''));
  }
  if (urls.length > 0) return `Weibo Regex Found: ${urls[0].slice(0, 50)}...`;
  
  return "Weibo nothing found";
}

async function runTests() {
  console.log(await extractTikTok("https://vm.tiktok.com/ZNR7eeRqB/") || "TikTok FAIL");
  console.log(await extractReddit("https://www.reddit.com/r/shiba/s/nC3HbrECzI") || "Reddit FAIL");
  console.log(await extractBilibili("https://www.bilibili.com/video/BV1PkR2BkEUt") || "Bilibili FAIL");
  console.log(await extractXiaohongshu("http://xhslink.com/o/AuDpBCMNn0z") || "XHS FAIL");
  console.log(await extractWeibo("https://mapp.api.weibo.cn/fx/d98fa849fa97fd2e8221047514eef64c.html") || "Weibo FAIL");
}

runTests();

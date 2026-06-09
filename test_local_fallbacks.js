// Simple node script to test the extraction logic of platformExtractors without importing react-native
const fetch = globalThis.fetch || (() => { try { return require('node-fetch'); } catch (e) { return null; } })();
if (!fetch) {
  console.error('Error: fetch is not available in your Node.js environment.');
  process.exit(1);
}

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonOrNull(res) {
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchHtml(url) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'en-US,en;q=0.9' } });
  return res.text();
}

async function extractTikTok(pageUrl) {
  const m = pageUrl.match(/\/video\/(\d+)/);
  if (!m) return null;
  const videoId = m[1];
  const res = await fetchWithTimeout(`https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}`, {
    headers: { 'User-Agent': MOBILE_UA }
  });
  const data = await fetchJsonOrNull(res);
  const aweme = data?.aweme_list?.[0];
  if (aweme?.video?.play_addr?.url_list?.length > 0) {
    return `TikTok Video Found: ${aweme.video.play_addr.url_list[0].slice(0, 50)}...`;
  }
  return null;
}

async function extractXiaohongshu(pageUrl) {
  // If shortlink, fetch it first to get redirect
  let url = pageUrl;
  if (pageUrl.includes('xhslink.com')) {
    const res = await fetchWithTimeout(pageUrl, { headers: { 'User-Agent': MOBILE_UA }, redirect: 'follow' });
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

async function extractReddit(pageUrl) {
  const jsonUrl = pageUrl.split('?')[0].replace(/\/$/, '') + '/.json';
  const res = await fetchWithTimeout(jsonUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
  if (!res.ok) return `Reddit failed: ${res.status}`;
  const data = await fetchJsonOrNull(res);
  const post = data?.[0]?.data?.children?.[0]?.data;
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

async function runTests() {
  console.log("Testing Native/Extension Local Fallback Extractors...");
  const samples = [
    ["TikTok", () => extractTikTok("https://www.tiktok.com/@nasa.tiktok2/video/7624845650504469780")],
    ["XHS", () => extractXiaohongshu("http://xhslink.com/o/AuDpBCMNn0z")],
    ["Reddit", () => extractReddit("https://www.reddit.com/r/shiba/s/nC3HbrECzI")],
    ["Bilibili", () => extractBilibili("https://www.bilibili.com/video/BV1PkR2BkEUt")],
  ];
  for (const [name, run] of samples) {
    try {
      console.log(await run() || `${name} FAIL`);
    } catch (e) {
      console.log(`${name} ERROR: ${e.message || e}`);
    }
  }
}

runTests();

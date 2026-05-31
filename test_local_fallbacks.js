// Simple node script to test the extraction logic of platformExtractors without importing react-native
const fetch = require('node-fetch') || globalThis.fetch;

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'en-US,en;q=0.9' } });
  return res.text();
}

async function extractTikTok(pageUrl) {
  const m = pageUrl.match(/\/video\/(\d+)/);
  if (!m) return null;
  const videoId = m[1];
  const res = await fetch(`https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}`, {
    headers: { 'User-Agent': MOBILE_UA }
  });
  const data = await res.json();
  const aweme = data.aweme_list?.[0];
  if (aweme?.video?.play_addr?.url_list?.length > 0) {
    return `TikTok Video Found: ${aweme.video.play_addr.url_list[0].slice(0, 50)}...`;
  }
  return null;
}

async function extractXiaohongshu(pageUrl) {
  // If shortlink, fetch it first to get redirect
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

async function extractReddit(pageUrl) {
  const jsonUrl = pageUrl.split('?')[0].replace(/\/$/, '') + '/.json';
  const res = await fetch(jsonUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
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

async function runTests() {
  console.log("Testing Native/Extension Local Fallback Extractors...");
  console.log(await extractTikTok("https://www.tiktok.com/@tiktok/video/7106594312292453678") || "TikTok FAIL");
  console.log(await extractXiaohongshu("http://xhslink.com/o/AuDpBCMNn0z") || "XHS FAIL");
  console.log(await extractReddit("https://www.reddit.com/r/videos/comments/18xzt8s/what_is_this_thing/") || "Reddit FAIL");
  console.log(await extractBilibili("https://www.bilibili.com/video/BV1GJ411x7h7/") || "Bilibili FAIL");
}

runTests();

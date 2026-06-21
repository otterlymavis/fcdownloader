import assert from 'node:assert/strict';
import { toDetectedMedia } from '../src/lib/serverExtractor';

const pageUrl = 'https://www.tiktok.com/@example/video/123';
const audioDisguisedAsHls = toDetectedMedia({
  kind: 'hls',
  url: 'https://v16m.tiktokcdn.com/media?a=123&mime_type=audio_mpeg',
  mimeType: 'video/m3u8',
}, pageUrl);

assert.equal(audioDisguisedAsHls.length, 1);
assert.equal(audioDisguisedAsHls[0].mediaKind, 'audio');
assert.equal(audioDisguisedAsHls[0].mediaType, 'direct');
assert.equal(audioDisguisedAsHls[0].mimeType, 'audio/mpeg');
assert.equal(audioDisguisedAsHls[0].hasVideo, false);

const realHls = toDetectedMedia({
  kind: 'hls',
  url: 'https://cdn.example.com/master.m3u8?token=abc',
}, pageUrl);
assert.equal(realHls[0].mediaKind, 'video');
assert.equal(realHls[0].mediaType, 'hls');

const twitterHls = toDetectedMedia({
  kind: 'hls',
  url: 'https://video.twimg.com/ext_tw_video/example/master.m3u8?token=short-lived',
}, 'https://x.com/example/status/123');
assert.equal(twitterHls[0].forceServerDownload, true);

const dailymotionHls = toDetectedMedia({
  kind: 'hls',
  url: 'https://cdndirector.dailymotion.com/cdn/manifest/video/example.m3u8?sec=short-lived',
}, 'https://www.dailymotion.com/video/example');
assert.equal(dailymotionHls[0].forceServerDownload, false);

console.log('server extractor tests passed');

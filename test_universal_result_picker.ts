import assert from 'node:assert/strict';
import { DetectedMedia } from './src/types';
import { getSourceName, smartDedup } from './src/lib/mediaHelpers';
import { decideUniversalResultHandling, sortUniversalCandidates } from './src/lib/universalResultPicker';

function item(
  url: string,
  mediaKind: NonNullable<DetectedMedia['mediaKind']>,
  confidence: number,
  mediaType: DetectedMedia['mediaType'] = 'direct',
): DetectedMedia {
  return {
    id: url,
    url,
    pageUrl: 'https://example.com/post',
    userAgent: '',
    timestamp: Date.now(),
    mediaType,
    mediaKind,
    confidence,
    extractor: 'universal-probe',
  };
}

const video = item('https://cdn.example.com/video.mp4', 'video', 0.82);
const hls = item('https://cdn.example.com/master.m3u8', 'video', 0.82, 'hls');
const audio = item('https://cdn.example.com/audio.m4a', 'audio', 0.95);
const image = item('https://cdn.example.com/image.jpg', 'image', 0.99);

assert.equal(decideUniversalResultHandling('universal-browser-probe', [video]).action, 'enqueue');
assert.equal(decideUniversalResultHandling('server-extraction', [video, hls]).action, 'enqueue');

const pick = decideUniversalResultHandling('universal-media-probe', [image, video, hls]);
assert.equal(pick.action, 'pick');
assert.deepEqual(pick.items.map((candidate) => candidate.url), [
  'https://cdn.example.com/master.m3u8',
  'https://cdn.example.com/video.mp4',
  'https://cdn.example.com/image.jpg',
]);

const sorted = sortUniversalCandidates([image, audio, video]);
assert.deepEqual(sorted.map((candidate) => candidate.mediaKind), ['video', 'audio', 'image']);

assert.equal(decideUniversalResultHandling('universal-browser-probe', []).action, 'none');

assert.equal(
  getSourceName(
    'https://scontent.cdninstagram.com/v/t50.2886-16/clip.mp4',
    'video',
    'https://www.threads.net/@zuck/post/C7VgIvhsKgR',
  ),
  'Threads',
);

// Resolution tie-breaking: same confidence and mediaType, higher resolution sorts first
const hd: DetectedMedia = { ...video, id: 'hd', url: 'https://cdn.example.com/hd.mp4', width: 1920, height: 1080 };
const sd: DetectedMedia = { ...video, id: 'sd', url: 'https://cdn.example.com/sd.mp4', width: 1280, height: 720 };
const lo: DetectedMedia = { ...video, id: 'lo', url: 'https://cdn.example.com/lo.mp4', width: 640, height: 360 };
const resSorted = sortUniversalCandidates([lo, hd, sd]);
assert.deepEqual(resSorted.map((c) => c.width), [1920, 1280, 640], 'Resolution descending sort');

const hlsMaster = item('https://cdn.example.com/video/master.m3u8', 'video', 0.9, 'hls');
const hls720 = item('https://cdn.example.com/video/720p/index.m3u8', 'video', 0.7, 'hls');
const hls360 = item('https://cdn.example.com/video/360p/index.m3u8', 'video', 0.7, 'hls');
const dedupedRefresh = sortUniversalCandidates([hls360, hls720, hlsMaster]);
assert.deepEqual(
  dedupedRefresh.map((candidate) => candidate.url),
  ['https://cdn.example.com/video/master.m3u8'],
  'Same-page HLS refresh variants collapse to one downloadable candidate',
);

const serverDecision = decideUniversalResultHandling('server-extraction', [hls360, hls720, hlsMaster]);
assert.equal(serverDecision.action, 'enqueue');
assert.deepEqual(
  serverDecision.items.map((candidate) => candidate.url),
  ['https://cdn.example.com/video/master.m3u8'],
  'Server extraction also auto-enqueues only one same-page HLS variant',
);

const muxPageUrl = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const muxMaster = { ...item(muxPageUrl, 'video', 0.85, 'hls'), pageUrl: muxPageUrl };
const muxVariants = [
  'url_0/193039199_mp4_h264_aac_hd_7.m3u8',
  'url_2/193039199_mp4_h264_aac_ld_7.m3u8',
  'url_4/193039199_mp4_h264_aac_7.m3u8',
  'url_6/193039199_mp4_h264_aac_hq_7.m3u8',
  'url_8/193039199_mp4_h264_aac_fhd_7.m3u8',
].map((path) => ({
  ...item(`https://test-streams.mux.dev/x36xhzz/${path}`, 'video', 0.85, 'hls'),
  pageUrl: muxPageUrl,
}));
const muxDirectPage = sortUniversalCandidates([...muxVariants, muxMaster]);
assert.deepEqual(
  muxDirectPage.map((candidate) => candidate.url),
  [muxPageUrl],
  'A direct HLS master page collapses bitrate child playlists and keeps the master URL',
);

const muxFrameScopedVariants = muxVariants.map((candidate) => ({
  ...candidate,
  pageUrl: candidate.url,
  sourcePageUrl: candidate.url,
}));
assert.deepEqual(
  smartDedup([muxMaster, ...muxFrameScopedVariants], muxPageUrl).map((candidate) => candidate.url),
  [muxPageUrl],
  'Browser dedup uses the top-level manifest URL when child frames report their own URLs',
);

const clipA = item('https://cdn.example.com/series/clip-a/master.m3u8', 'video', 0.8, 'hls');
const clipB = item('https://cdn.example.com/series/clip-b/master.m3u8', 'video', 0.8, 'hls');
const separateStreams = sortUniversalCandidates([clipB, clipA]);
assert.deepEqual(
  separateStreams.map((candidate) => candidate.url),
  [
    'https://cdn.example.com/series/clip-a/master.m3u8',
    'https://cdn.example.com/series/clip-b/master.m3u8',
  ],
  'Separate same-page HLS streams stay selectable',
);

console.log('universal result picker ok');

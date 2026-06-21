import assert from 'node:assert/strict';
import { DetectedMedia } from '../src/types';
import { getSourceName, smartDedup } from '../src/lib/mediaHelpers';
import {
  decideUniversalResultHandling,
  simplifyUniversalPickerCandidates,
  sortUniversalCandidates,
} from '../src/lib/universalResultPicker';

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

const expiringLow = item('https://media.example.com/post/clip.mp4?token=old', 'video', 0.6);
const expiringHigh = item('https://media.example.com/post/clip.mp4?token=new', 'video', 0.9);
assert.deepEqual(
  simplifyUniversalPickerCandidates([expiringLow, expiringHigh]).map((candidate) => candidate.url),
  ['https://media.example.com/post/clip.mp4?token=new'],
  'Tokenized URLs for the same media file collapse to the best candidate',
);
const duplicateDecision = decideUniversalResultHandling(
  'universal-media-probe',
  [expiringLow, expiringHigh],
  'https://example.com/post',
);
assert.equal(duplicateDecision.action, 'enqueue');
assert.deepEqual(
  duplicateDecision.items.map((candidate) => candidate.url),
  ['https://media.example.com/post/clip.mp4?token=new'],
  'A noisy list representing one real asset skips the picker',
);

const hdVariant = item('https://media.example.com/post/clip.mp4?token=a&quality=hd', 'video', 0.8);
const sdVariant = item('https://media.example.com/post/clip.mp4?token=b&quality=sd', 'video', 0.8);
assert.equal(
  simplifyUniversalPickerCandidates([hdVariant, sdVariant]).length,
  2,
  'Query parameters that change media quality remain selectable',
);
assert.equal(
  decideUniversalResultHandling(
    'universal-media-probe',
    [hdVariant, sdVariant],
    'https://example.com/post',
  ).action,
  'pick',
  'Different media qualities still open the picker',
);

const wideImage = item('https://images.example.com/post.jpg?width=2048&format=pjpg&token=a', 'image', 0.8);
const smallImage = item('https://images.example.com/post.jpg?format=pjpg&token=b&width=640', 'image', 0.8);
assert.equal(
  simplifyUniversalPickerCandidates([wideImage, smallImage]).length,
  2,
  'Image transformation parameters remain distinct regardless of query order',
);
assert.equal(
  decideUniversalResultHandling(
    'universal-browser-probe',
    [wideImage, smallImage],
    'https://example.com/post',
  ).action,
  'pick',
  'Different image transformations still open the picker',
);

const reorderedOld = item(
  'https://media.example.com/post/clip.mp4?quality=hd&token=old&format=mp4',
  'video',
  0.7,
);
const reorderedNew = item(
  'https://media.example.com/post/clip.mp4?format=mp4&token=new&quality=hd',
  'video',
  0.9,
);
assert.deepEqual(
  simplifyUniversalPickerCandidates([reorderedOld, reorderedNew]).map((candidate) => candidate.url),
  [reorderedNew.url],
  'Stable query parameters are order-independent while refreshed tokens collapse',
);

const alternatePort = item('https://media.example.com:8443/post/clip.mp4?token=new', 'video', 0.9);
assert.equal(
  simplifyUniversalPickerCandidates([expiringHigh, alternatePort]).length,
  2,
  'Different media origins remain distinct when their ports differ',
);

const endpointA = item('https://media.example.com/watch?id=asset-a', 'video', 0.8);
const endpointB = item('https://media.example.com/watch?id=asset-b', 'video', 0.8);
assert.equal(
  simplifyUniversalPickerCandidates([endpointA, endpointB]).length,
  2,
  'Extensionless query-ID endpoints remain distinct',
);

const galleryA = item('https://images.example.com/gallery/image-1.jpg?token=a', 'image', 0.8);
const galleryB = item('https://images.example.com/gallery/image-2.jpg?token=b', 'image', 0.8);
assert.equal(
  simplifyUniversalPickerCandidates([galleryA, galleryB]).length,
  2,
  'Different gallery paths remain selectable',
);

const vimeoPage = 'https://player.vimeo.com/video/103195?h=private';
const vimeoHls = {
  ...item('https://vod-adaptive.vimeocdn.com/video/master.m3u8?token=a', 'video', 0.85, 'hls'),
  pageUrl: vimeoPage,
  label: 'Performance title',
  provenance: 'perf-observer' as const,
};
const vimeoJson = {
  ...item('https://vod-adaptive.vimeocdn.com/video/playlist.json?token=a', 'video', 0.88),
  pageUrl: vimeoPage,
  mimeType: 'application/json',
  label: 'application/json',
  provenance: 'xhr-hook' as const,
};
const vimeoPoster = {
  ...item('https://i.vimeocdn.com/video/poster.webp', 'image', 0.4),
  pageUrl: vimeoPage,
};
const vimeoConfig = {
  ...item('https://player.vimeo.com/video/103195/config?h=private', 'video', 0.9),
  pageUrl: 'https://amuseplus.jp/mob/pageShw.php',
  mimeType: 'application/json',
  label: 'Vimeo player config',
};
const pageLogo = {
  ...item('https://amuseplus.jp/assets/logo.png', 'image', 0.5),
  pageUrl: 'https://amuseplus.jp/mob/pageShw.php',
};
const collapsedVimeo = simplifyUniversalPickerCandidates(
  [vimeoHls, vimeoJson, vimeoPoster, vimeoConfig, pageLogo],
  'https://amuseplus.jp/mob/pageShw.php',
);
assert.equal(collapsedVimeo.length, 2, 'one Vimeo embed and an unrelated page image should remain selectable');
const collapsedVimeoVideo = collapsedVimeo.find((candidate) => candidate.mediaKind === 'video');
assert.equal(collapsedVimeoVideo?.url, vimeoConfig.url, 'stable Vimeo config should back the visible item');
assert.equal(collapsedVimeoVideo?.label, 'Performance title', 'useful player title should survive collapsing');
assert(
  collapsedVimeo.some((candidate) => candidate.url === pageLogo.url),
  'unrelated page images should not be removed just because a Vimeo embed exists',
);

const threadsPage = 'https://www.threads.net/@example/post/abc';
const threadsOld = {
  ...item('https://scontent.cdninstagram.com/v/t50/asset?token=old', 'video', 0.7),
  pageUrl: threadsPage,
};
const threadsNew = {
  ...item('https://scontent.cdninstagram.com/v/t50/asset?token=new', 'video', 0.9),
  pageUrl: threadsPage,
};
assert.equal(
  simplifyUniversalPickerCandidates([threadsOld, threadsNew], threadsPage).length,
  1,
  'Threads extensionless CDN duplicates still collapse',
);

console.log('universal result picker ok');

import assert from 'node:assert/strict';
import { DetectedMedia } from './src/types';
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

// Resolution tie-breaking: same confidence and mediaType, higher resolution sorts first
const hd: DetectedMedia = { ...video, id: 'hd', url: 'https://cdn.example.com/hd.mp4', width: 1920, height: 1080 };
const sd: DetectedMedia = { ...video, id: 'sd', url: 'https://cdn.example.com/sd.mp4', width: 1280, height: 720 };
const lo: DetectedMedia = { ...video, id: 'lo', url: 'https://cdn.example.com/lo.mp4', width: 640, height: 360 };
const resSorted = sortUniversalCandidates([lo, hd, sd]);
assert.deepEqual(resSorted.map((c) => c.width), [1920, 1280, 640], 'Resolution descending sort');

console.log('universal result picker ok');

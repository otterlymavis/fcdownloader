import assert from 'node:assert/strict';
import { mediaHintsFromNetworkLog } from '../src/lib/browserSessionStrategies';
import { probeUniversalMedia } from '../src/lib/universalMediaProbe';

const pageUrl = 'https://example.com/watch/123';

const hints = mediaHintsFromNetworkLog([
  {
    url: 'https://cdn.example.com/live/master.m3u8',
    pageUrl,
    method: 'GET',
    status: 206,
    mimeType: 'application/vnd.apple.mpegurl',
    contentLength: 2_400_000,
    provenance: 'fetch-hook',
    initiatorType: 'fetch',
  },
  {
    url: 'https://cdn.example.com/thumbs/card.jpg',
    status: 200,
    mimeType: 'image/jpeg',
    encodedBodySize: 42_000,
    provenance: 'perf-observer',
  },
  {
    url: 'https://signed.example.net/playback?id=abc123',
    status: 200,
    mimeType: 'video/mp4',
    contentLength: 8_500_000,
    provenance: 'xhr-hook',
  },
  {
    url: 'https://signed.example.net/manifest?id=def456',
    status: 200,
    mimeType: 'application/vnd.apple.mpegurl',
    provenance: 'fetch-hook',
  },
  {
    url: 'https://api.example.net/config?id=def456',
    status: 200,
    mimeType: 'application/json',
    provenance: 'fetch-hook',
  },
  {
    url: 'https://vod-adaptive-ak.vimeocdn.com/video/12345/sep/video/abcdef/playlist.json?pathsig=abc',
    pageUrl,
    status: 200,
    mimeType: 'application/json',
    provenance: 'fetch-hook',
  },
  {
    url: 'https://player.vimeo.com/video/76979871/config',
    pageUrl,
    status: 200,
    mimeType: 'application/json',
    provenance: 'xhr-hook',
  },
], pageUrl);

const hlsHint = hints.find((hint) => hint.url === 'https://cdn.example.com/live/master.m3u8');
assert.equal(hlsHint?.kind, 'hls');
assert.equal(hlsHint?.mimeType, 'application/vnd.apple.mpegurl');
assert.equal(hlsHint?.status, 206);
assert.equal(hlsHint?.contentLength, 2_400_000);
assert.equal(hlsHint?.source, 'fetch-hook');
assert(Number(hlsHint?.confidence) > 0.8);

const media = probeUniversalMedia({ pageUrl, mediaHints: hints });
const hls = media.find((item) => item.url === 'https://cdn.example.com/live/master.m3u8');
assert.equal(hls?.mediaType, 'hls');
assert.equal(hls?.provenance, 'fetch-hook');
assert.equal(hls?.sourceAudit?.[0]?.source, 'fetch-hook');
assert.equal(hls?.sourceAudit?.[0]?.status, 206);
assert.equal(hls?.sourceAudit?.[0]?.contentLength, 2_400_000);

const image = media.find((item) => item.url === 'https://cdn.example.com/thumbs/card.jpg');
assert.equal(image?.mediaKind, 'image');
assert.equal(image?.sourceAudit?.[0]?.contentLength, 42_000);

const signedVideoHint = hints.find((hint) => hint.url === 'https://signed.example.net/playback?id=abc123');
assert.equal(signedVideoHint?.kind, 'video');
assert.equal(signedVideoHint?.mimeType, 'video/mp4');
assert(Number(signedVideoHint?.confidence) > 0.8);

const signedHlsHint = hints.find((hint) => hint.url === 'https://signed.example.net/manifest?id=def456');
assert.equal(signedHlsHint?.kind, 'hls');
assert.equal(signedHlsHint?.mimeType, 'application/vnd.apple.mpegurl');

assert(!hints.some((hint) => hint.url === 'https://api.example.net/config?id=def456'));

const vimeoPlaylistHint = hints.find((hint) => hint.url === 'https://vod-adaptive-ak.vimeocdn.com/video/12345/sep/video/abcdef/playlist.json?pathsig=abc');
assert.equal(vimeoPlaylistHint?.kind, 'video');
assert.equal(vimeoPlaylistHint?.mimeType, 'application/json');

const vimeoConfigHint = hints.find((hint) => hint.url === 'https://player.vimeo.com/video/76979871/config');
assert.equal(vimeoConfigHint?.kind, 'video');
assert.equal(vimeoConfigHint?.mimeType, 'application/json');

const signedVideo = media.find((item) => item.url === 'https://signed.example.net/playback?id=abc123');
assert.equal(signedVideo?.mediaType, 'direct');
assert.equal(signedVideo?.mediaKind, 'video');
assert.equal(signedVideo?.provenance, 'xhr-hook');

const signedHls = media.find((item) => item.url === 'https://signed.example.net/manifest?id=def456');
assert.equal(signedHls?.mediaType, 'hls');
assert.equal(signedHls?.mediaKind, 'video');

const vimeoPlaylist = media.find((item) => item.url === 'https://vod-adaptive-ak.vimeocdn.com/video/12345/sep/video/abcdef/playlist.json?pathsig=abc');
assert.equal(vimeoPlaylist?.mediaType, 'direct');
assert.equal(vimeoPlaylist?.mediaKind, 'video');

const vimeoConfig = media.find((item) => item.url === 'https://player.vimeo.com/video/76979871/config');
assert.equal(vimeoConfig?.mediaType, 'direct');
assert.equal(vimeoConfig?.mediaKind, 'video');

console.log('browser session network hints ok');

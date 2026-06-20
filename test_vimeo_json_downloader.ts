import assert from 'node:assert/strict';
import {
  findVimeoPlaylistJsonUrl,
  loadVimeoPlaylist,
  selectVimeoTracks,
  VimeoPlaylist,
  VimeoTrack,
} from './src/lib/vimeoJsonDownloader';

function track(
  id: string,
  bitrate: number,
  dimensions?: { width: number; height: number },
): VimeoTrack {
  return {
    id,
    bitrate,
    width: dimensions?.width,
    height: dimensions?.height,
    init_segment: 'AAAA',
    segments: [{ url: 'segment.m4s' }],
  };
}

const pairedPlaylist: VimeoPlaylist = {
  video: [
    track('sd', 800_000, { width: 640, height: 360 }),
    track('hd', 2_800_000, { width: 1280, height: 720 }),
  ],
  audio: [
    track('sd', 192_000),
    track('hd', 128_000),
  ],
};

const paired = selectVimeoTracks(pairedPlaylist);
assert.equal(paired.video?.id, 'hd', 'highest-resolution Vimeo video track should be selected');
assert.equal(
  paired.audio?.id,
  'hd',
  'audio from the selected Vimeo rendition group should be preferred over an unmatched higher-bitrate track',
);

const fallback = selectVimeoTracks({
  video: [track('video-only-id', 2_800_000, { width: 1280, height: 720 })],
  audio: [track('low', 96_000), track('high', 192_000)],
});
assert.equal(
  fallback.audio?.id,
  'high',
  'highest-bitrate audio should be used when Vimeo track IDs do not match',
);

const escapedPlaylist =
  'https:\\/\\/vod-adaptive-ak.vimeocdn.com\\/video\\/123\\/sep\\/video\\/abc\\/playlist.json' +
  '?pathsig=secret\\u0026expires\\u003d123';
assert.equal(
  findVimeoPlaylistJsonUrl(
    { request: { files: { dash: { cdns: { akfire_interconnect_quic: { avc_url: escapedPlaylist } } } } } },
    'https://player.vimeo.com/video/76979871/config',
  ),
  'https://vod-adaptive-ak.vimeocdn.com/video/123/sep/video/abc/playlist.json?pathsig=secret&expires=123',
  'nested escaped Vimeo playlist URLs should resolve without losing signed query parameters',
);

assert.equal(
  findVimeoPlaylistJsonUrl(
    { playlist_url: '//vod-adaptive-ak.vimeocdn.com/video/123/sep/video/abc/playlist.json?token=a&amp;b=c' },
    'https://player.vimeo.com/video/76979871/config',
  ),
  'https://vod-adaptive-ak.vimeocdn.com/video/123/sep/video/abc/playlist.json?token=a&b=c',
  'protocol-relative Vimeo playlist URLs and HTML-escaped query parameters should normalize',
);

const cyclicConfig: Record<string, unknown> = {};
cyclicConfig.self = cyclicConfig;
cyclicConfig.unrelated = 'https://api.example.com/config.json';
assert.equal(
  findVimeoPlaylistJsonUrl(cyclicConfig, 'https://player.vimeo.com/video/76979871/config'),
  undefined,
  'cyclic or unrelated config data should not produce a Vimeo playlist candidate',
);

const stalePlaylistUrl =
  'https://vod-adaptive-ak.vimeocdn.com/video/123/sep/video/abc/playlist.json?token=stale';
const freshConfigUrl = 'https://player.vimeo.com/video/76979871/config';
const freshPlaylistUrl =
  'https://vod-adaptive-ak.vimeocdn.com/video/123/sep/video/abc/playlist.json?token=fresh';
async function testExpiredPlaylistRefresh(): Promise<void> {
  const fetchCalls: string[] = [];
  const refreshed = await loadVimeoPlaylist(
    stalePlaylistUrl,
    {},
    {
      onTokenExpired: async (expiredUrl) => {
        assert.equal(expiredUrl, stalePlaylistUrl);
        return freshConfigUrl;
      },
    },
    async (url) => {
      fetchCalls.push(url);
      if (url === stalePlaylistUrl) return new Response('', { status: 403 }) as never;
      if (url === freshConfigUrl) {
        return new Response(JSON.stringify({
          request: { files: { dash: { cdns: { fastly: { avc_url: freshPlaylistUrl } } } } },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as never;
      }
      if (url === freshPlaylistUrl) {
        return new Response(JSON.stringify({
          video: [track('fresh', 2_000_000, { width: 1280, height: 720 })],
          audio: [track('fresh', 128_000)],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as never;
      }
      throw new Error(`Unexpected Vimeo test URL: ${url}`);
    },
  );
  assert.equal(refreshed.playlistUrl, freshPlaylistUrl);
  assert.equal(refreshed.playlist.video?.[0]?.id, 'fresh');
  assert.deepEqual(
    fetchCalls,
    [stalePlaylistUrl, freshConfigUrl, freshPlaylistUrl],
    'expired Vimeo playlist should refresh once through config and resolve the replacement playlist',
  );
}

async function testRefreshCanRevisitOriginalConfig(): Promise<void> {
  const fetchCalls: string[] = [];
  let configFetches = 0;
  const refreshed = await loadVimeoPlaylist(
    freshConfigUrl,
    {},
    {
      onTokenExpired: async (expiredUrl) => {
        assert.equal(expiredUrl, stalePlaylistUrl);
        return freshConfigUrl;
      },
    },
    async (url) => {
      fetchCalls.push(url);
      if (url === freshConfigUrl) {
        configFetches += 1;
        const playlistUrl = configFetches === 1 ? stalePlaylistUrl : freshPlaylistUrl;
        return new Response(JSON.stringify({
          request: { files: { dash: { cdns: { fastly: { avc_url: playlistUrl } } } } },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as never;
      }
      if (url === stalePlaylistUrl) return new Response('', { status: 403 }) as never;
      if (url === freshPlaylistUrl) {
        return new Response(JSON.stringify({
          video: [track('fresh', 2_000_000, { width: 1280, height: 720 })],
          audio: [track('fresh', 128_000)],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }) as never;
      }
      throw new Error(`Unexpected Vimeo test URL: ${url}`);
    },
  );
  assert.equal(refreshed.playlistUrl, freshPlaylistUrl);
  assert.deepEqual(
    fetchCalls,
    [freshConfigUrl, stalePlaylistUrl, freshConfigUrl, freshPlaylistUrl],
    'refreshing an expired signed playlist should be able to revisit its original config URL',
  );
}

Promise.resolve()
  .then(testExpiredPlaylistRefresh)
  .then(testRefreshCanRevisitOriginalConfig)
  .then(() => console.log('Vimeo JSON downloader helpers ok'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

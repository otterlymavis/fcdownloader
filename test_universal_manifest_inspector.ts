import './test_setup.js';
import assert from 'node:assert/strict';
import { DetectedMedia } from './src/types';
import {
  inspectManifestCandidate,
  inspectUniversalManifestCandidates,
} from './src/lib/universalManifestInspector';

function item(url: string, mediaType: DetectedMedia['mediaType']): DetectedMedia {
  return {
    id: url,
    url,
    pageUrl: 'https://example.com/watch',
    userAgent: '',
    timestamp: Date.now(),
    mediaType,
    mediaKind: 'video',
    confidence: 0.86,
    extractor: 'universal-probe',
  };
}

function mockFetch(body: string, init: { status?: number; contentType?: string; contentLength?: string } = {}): typeof fetch {
  return (async () => new Response(body, {
    status: init.status ?? 200,
    headers: {
      'Content-Type': init.contentType ?? 'text/plain',
      ...(init.contentLength ? { 'Content-Length': init.contentLength } : {}),
    },
  })) as typeof fetch;
}

async function testHlsMasterVariants() {
  const hls = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080,FRAME-RATE=29.97,CODECS="avc1.640028,mp4a.40.2"
high/index.m3u8`;
  const inspected = await inspectManifestCandidate(item('https://cdn.example.com/master.m3u8', 'hls'), {
    fetchImpl: mockFetch(hls, { contentType: 'application/vnd.apple.mpegurl' }),
  });

  assert.equal(inspected.label, 'HLS master playlist');
  assert.equal(inspected.height, 1080);
  assert.equal(inspected.width, 1920);
  assert.equal(inspected.availableFormats?.length, 2);
  assert.equal(inspected.availableFormats?.[0]?.height, 1080);
  assert.equal(inspected.availableFormats?.[0]?.protocol, 'm3u8');
  assert.equal(inspected.availableFormats?.[0]?.url, 'https://cdn.example.com/high/index.m3u8');
  assert.equal(inspected.availableFormats?.[0]?.selectable, true);
  assert.match(inspected.sourceAudit?.at(-1)?.notes ?? '', /hls-master/);
}

async function testHlsMediaAndDrmHint() {
  const media = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6,
seg0.ts
#EXT-X-ENDLIST`;
  const inspected = await inspectManifestCandidate(item('https://cdn.example.com/media.m3u8', 'hls'), {
    fetchImpl: mockFetch(media),
  });

  assert.equal(inspected.label, 'HLS media playlist');
  assert.equal(inspected.availableFormats?.[0]?.id, 'hls_media');
  assert.match(inspected.sourceAudit?.at(-1)?.rejectedReason ?? '', /DRM|SAMPLE-AES|Encrypted/i);
}

async function testDashMpdFormatsAndDrmHint() {
  const mpd = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" />
      <Representation id="v360" bandwidth="800000" width="640" height="360" codecs="avc1.4d401e" />
      <Representation id="v1080" bandwidth="4500000" width="1920" height="1080" codecs="avc1.640028" />
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2" />
    </AdaptationSet>
  </Period>
</MPD>`;
  const inspected = await inspectManifestCandidate(item('https://cdn.example.com/manifest.mpd', 'dash'), {
    fetchImpl: mockFetch(mpd, { contentType: 'application/dash+xml' }),
  });

  assert.equal(inspected.label, 'DASH MPD');
  assert.equal(inspected.height, 1080);
  assert.equal(inspected.availableFormats?.[0]?.id, 'v1080');
  assert.equal(inspected.availableFormats?.[0]?.selectable, true);
  assert.equal(inspected.availableFormats?.[0]?.mediaKind, 'video');
  assert.equal(inspected.availableFormats?.[0]?.audioFormatId, 'a1');
  const audio = inspected.availableFormats?.find((format) => format.mediaKind === 'audio');
  assert.equal(audio?.selectable, false);
  assert.equal(audio?.resolution, 'audio only');
  assert.match(inspected.sourceAudit?.at(-1)?.rejectedReason ?? '', /ContentProtection|DRM|PSSH/i);
}

async function testFailureReturnsOriginalShapeWithAudit() {
  const original = item('https://cdn.example.com/not-manifest.m3u8', 'hls');
  const inspected = await inspectManifestCandidate(original, {
    fetchImpl: mockFetch('<html>nope</html>'),
  });

  assert.equal(inspected.url, original.url);
  assert.equal(inspected.availableFormats, undefined);
  assert.match(inspected.sourceAudit?.at(-1)?.notes ?? '', /inspection failed/i);
}

async function testOversizedReturnsOriginalShapeWithAudit() {
  const original = item('https://cdn.example.com/huge.m3u8', 'hls');
  const inspected = await inspectManifestCandidate(original, {
    fetchImpl: mockFetch('#EXTM3U', { contentLength: '999999' }),
    maxChars: 10,
  });

  assert.equal(inspected.url, original.url);
  assert.match(inspected.sourceAudit?.at(-1)?.rejectedReason ?? '', /too large/i);
}

async function testUniversalOnlyIntegration() {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts');
  }) as typeof fetch;
  const universal = await inspectUniversalManifestCandidates('universal-browser-probe', [item('https://cdn.example.com/media.m3u8', 'hls')], { fetchImpl });
  const server = await inspectUniversalManifestCandidates('server-extraction', [item('https://cdn.example.com/server.m3u8', 'hls')], { fetchImpl });

  assert.equal(calls, 1);
  assert.equal(universal[0].availableFormats?.[0]?.id, 'hls_media');
  assert.equal(server[0].availableFormats, undefined);
}

async function testDashSubtitleVtt() {
  const mpd = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v720" bandwidth="2000000" width="1280" height="720" />
    </AdaptationSet>
    <AdaptationSet mimeType="text/vtt" lang="en">
      <Representation id="sub_en" bandwidth="5000" />
    </AdaptationSet>
    <AdaptationSet mimeType="text/vtt" lang="fr">
      <Representation id="sub_fr" bandwidth="4800" />
    </AdaptationSet>
  </Period>
</MPD>`;
  const inspected = await inspectManifestCandidate(item('https://cdn.example.com/subs.mpd', 'dash'), {
    fetchImpl: mockFetch(mpd, { contentType: 'application/dash+xml' }),
  });

  const formats = inspected.availableFormats ?? [];
  const subtitles = formats.filter((f) => f.mediaKind === 'subtitle');
  assert.equal(subtitles.length, 2);
  const en = subtitles.find((f) => f.id === 'sub_en');
  assert.ok(en, 'English subtitle track not found');
  assert.equal(en!.selectable, false);
  assert.equal(en!.ext, 'vtt');
  assert.match(en!.label ?? '', /Subtitle/);
  assert.match(en!.label ?? '', /en/);
  assert.equal(en!.resolution, 'subtitle');
  // Video track should still be found
  const video = formats.find((f) => f.mediaKind === 'video');
  assert.ok(video);
  assert.equal(video!.selectable, true);
}

async function testDashSubtitleTtml() {
  const mpd = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v1080" bandwidth="4000000" width="1920" height="1080" />
    </AdaptationSet>
    <AdaptationSet mimeType="application/ttml+xml" lang="ja">
      <Representation id="sub_ja" bandwidth="3000" />
    </AdaptationSet>
  </Period>
</MPD>`;
  const inspected = await inspectManifestCandidate(item('https://cdn.example.com/ttml.mpd', 'dash'), {
    fetchImpl: mockFetch(mpd, { contentType: 'application/dash+xml' }),
  });

  const formats = inspected.availableFormats ?? [];
  const sub = formats.find((f) => f.mediaKind === 'subtitle');
  assert.ok(sub, 'TTML subtitle track not found');
  assert.equal(sub!.ext, 'ttml');
  assert.match(sub!.label ?? '', /ja/);
}

async function testDashSubtitleLangFromContentType() {
  // contentType-only detection (no explicit lang on the AdaptationSet)
  const mpd = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet contentType="text">
      <Representation id="sub_only" bandwidth="2000" />
    </AdaptationSet>
  </Period>
</MPD>`;
  const inspected = await inspectManifestCandidate(item('https://cdn.example.com/text-ct.mpd', 'dash'), {
    fetchImpl: mockFetch(mpd, { contentType: 'application/dash+xml' }),
  });

  const sub = (inspected.availableFormats ?? []).find((f) => f.mediaKind === 'subtitle');
  assert.ok(sub, 'contentType=text should be detected as subtitle');
  assert.equal(sub!.selectable, false);
}

async function testHlsCodecLabels() {
  const hls = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
high/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS="av01.0.08M.08,opus"
av1/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/index.m3u8`;
  const inspected = await inspectManifestCandidate(item('https://cdn.example.com/master.m3u8', 'hls'), {
    fetchImpl: mockFetch(hls, { contentType: 'application/vnd.apple.mpegurl' }),
  });

  const fmts = inspected.availableFormats ?? [];
  const h264 = fmts.find((f) => f.height === 1080);
  assert.ok(h264, '1080p format not found');
  assert.match(h264!.label ?? '', /H\.264/);
  assert.match(h264!.label ?? '', /1080p/);
  assert.match(h264!.label ?? '', /4\.0 Mbps/);

  const av1 = fmts.find((f) => f.height === 720);
  assert.ok(av1, '720p AV1 format not found');
  assert.match(av1!.label ?? '', /AV1/);

  // No CODECS attr → label has no codec parenthetical
  const noCodec = fmts.find((f) => f.height === 360);
  assert.ok(noCodec, '360p format not found');
  assert.doesNotMatch(noCodec!.label ?? '', /\(.*\)/);
}

async function testDashCodecLabels() {
  const mpd = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028" />
      <Representation id="v720" bandwidth="2500000" width="1280" height="720" codecs="hev1.1.6.L150.90" />
      <Representation id="v360" bandwidth="600000" width="640" height="360" />
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2" />
      <Representation id="a_opus" bandwidth="96000" codecs="opus" />
    </AdaptationSet>
  </Period>
</MPD>`;
  const inspected = await inspectManifestCandidate(item('https://cdn.example.com/manifest.mpd', 'dash'), {
    fetchImpl: mockFetch(mpd),
  });

  const fmts = inspected.availableFormats ?? [];
  const h264 = fmts.find((f) => f.id === 'v1080');
  assert.ok(h264, '1080p H.264 not found');
  assert.match(h264!.label ?? '', /H\.264/);

  const hevc = fmts.find((f) => f.id === 'v720');
  assert.ok(hevc, '720p HEVC not found');
  assert.match(hevc!.label ?? '', /HEVC/);

  const noCodec = fmts.find((f) => f.id === 'v360');
  assert.ok(noCodec, '360p no-codec not found');
  assert.doesNotMatch(noCodec!.label ?? '', /\(.*\)/);

  const aac = fmts.find((f) => f.id === 'a128');
  assert.ok(aac, 'AAC audio not found');
  assert.match(aac!.label ?? '', /AAC/);

  const opus = fmts.find((f) => f.id === 'a_opus');
  assert.ok(opus, 'Opus audio not found');
  assert.match(opus!.label ?? '', /Opus/);
}

async function testDashLiveStream() {
  const mpd = `<?xml version="1.0"?>
<MPD type="dynamic" minimumUpdatePeriod="PT5S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v720" bandwidth="2000000" width="1280" height="720" />
    </AdaptationSet>
  </Period>
</MPD>`;
  const inspected = await inspectManifestCandidate(item('https://live.example.com/stream.mpd', 'dash'), {
    fetchImpl: mockFetch(mpd, { contentType: 'application/dash+xml' }),
  });

  assert.equal(inspected.liveStream, true);
  assert.equal(inspected.label, 'DASH live stream');
  assert.match(inspected.sourceAudit?.at(-1)?.notes ?? '', /live stream/);
}

async function testHlsImageStreamInf() {
  const hls = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2"
720p/index.m3u8
#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=57600,RESOLUTION=220x124,CODECS="jpeg",URI="thumbs/storyboard.m3u8"
#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=115200,RESOLUTION=440x248,CODECS="jpeg",URI="thumbs/storyboard_hd.m3u8"`;
  const inspected = await inspectManifestCandidate(item('https://cdn.example.com/master.m3u8', 'hls'), {
    fetchImpl: mockFetch(hls, { contentType: 'application/vnd.apple.mpegurl' }),
  });

  const fmts = inspected.availableFormats ?? [];
  const videoFmts = fmts.filter((f) => !f.mediaKind || f.mediaKind === 'video');
  const imageFmts = fmts.filter((f) => f.mediaKind === 'image');

  assert.equal(videoFmts.length, 1, 'Expected one video variant');
  assert.equal(imageFmts.length, 2, 'Expected two image storyboard tracks');
  assert.ok(imageFmts.every((f) => f.url?.includes('storyboard')), 'All storyboard URLs should include "storyboard"');
  assert.ok(imageFmts.every((f) => f.selectable === false), 'Storyboard tracks should not be selectable');
  assert.ok(imageFmts.every((f) => /[Ss]toryboard/.test(f.label ?? '')));
  // Sorted by height descending — HD (440x248) comes before SD (220x124)
  assert.equal(imageFmts[0].width, 440);
  assert.equal(imageFmts[0].height, 248);
  assert.equal(imageFmts[1].width, 220);
  assert.equal(imageFmts[1].height, 124);
}

async function testDashAudioLanguage() {
  const mpd = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v1" bandwidth="2000000" width="1280" height="720" />
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="en" label="English">
      <Representation id="a_en" bandwidth="128000" codecs="mp4a.40.2" />
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="de" label="Deutsch">
      <Representation id="a_de" bandwidth="128000" codecs="mp4a.40.2" />
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="ja" label="Japanese">
      <Representation id="a_ja" bandwidth="64000" codecs="mp4a.40.2" />
    </AdaptationSet>
  </Period>
</MPD>`;
  const inspected = await inspectManifestCandidate(item('https://cdn.example.com/multi-audio.mpd', 'dash'), {
    fetchImpl: mockFetch(mpd, { contentType: 'application/dash+xml' }),
  });

  const audioFmts = (inspected.availableFormats ?? []).filter((f) => f.mediaKind === 'audio');
  assert.equal(audioFmts.length, 3, 'Three audio tracks expected');

  const enTrack = audioFmts.find((f) => f.language === 'en');
  assert.ok(enTrack, 'English audio track should have language=en');
  assert.match(enTrack?.label ?? '', /en/i, 'English label should mention language');

  const deTrack = audioFmts.find((f) => f.language === 'de');
  assert.ok(deTrack, 'German audio track should have language=de');

  const jaTrack = audioFmts.find((f) => f.language === 'ja');
  assert.ok(jaTrack, 'Japanese audio track should have language=ja');
  assert.equal(jaTrack?.bitrate, 64000, 'Japanese track bitrate should be set');
}

async function testHlsAudioLanguage() {
  const hls = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="fr",NAME="Français",DEFAULT=NO,URI="fr.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="en",NAME="English",DEFAULT=YES,URI="en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="audio"
720p.m3u8`;
  const inspected = await inspectManifestCandidate(item('https://cdn.example.com/master.m3u8', 'hls'), {
    fetchImpl: mockFetch(hls, { contentType: 'application/vnd.apple.mpegurl' }),
  });

  const audioFmts = (inspected.availableFormats ?? []).filter((f) => f.mediaKind === 'audio');
  assert.equal(audioFmts.length, 2, 'Two audio tracks expected');

  const frTrack = audioFmts.find((f) => f.language === 'fr');
  assert.ok(frTrack, 'French audio track should have language=fr');
  assert.match(frTrack?.label ?? '', /Fran/i);

  const enTrack = audioFmts.find((f) => f.language === 'en');
  assert.ok(enTrack, 'English audio track should have language=en');
  assert.match(enTrack?.label ?? '', /default/i, 'Default track label should note default');
}

async function testHlsAes128NotBlocked() {
  const hls = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/key.bin",IV=0x00000000000000000000000000000001
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720p/index.m3u8`;
  const inspected = await inspectManifestCandidate(item('https://cdn.example.com/master.m3u8', 'hls'), {
    fetchImpl: mockFetch(hls, { contentType: 'application/vnd.apple.mpegurl' }),
  });

  // AES-128 is downloadable — must NOT set rejectedReason
  assert.equal(inspected.sourceAudit?.at(-1)?.rejectedReason, undefined, 'AES-128 HLS must not have rejectedReason');
  // But the note should mention encryption
  assert.match(inspected.sourceAudit?.at(-1)?.notes ?? '', /AES-128/i, 'AES-128 note should appear in audit');
}

async function testDashMpdDuration() {
  const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT1H32M45S" minBufferTime="PT2S">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v1080" bandwidth="4000000" width="1920" height="1080" />
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="a1" bandwidth="128000" />
    </AdaptationSet>
  </Period>
</MPD>`;
  const inspected = await inspectManifestCandidate(item('https://cdn.example.com/movie.mpd', 'dash'), {
    fetchImpl: mockFetch(mpd, { contentType: 'application/dash+xml' }),
  });

  // PT1H32M45S = 3600 + 1920 + 45 = 5565 seconds
  assert.equal(inspected.duration, 5565, 'DASH mediaPresentationDuration should parse to seconds');
  assert.equal(inspected.liveStream, undefined, 'VOD DASH should not set liveStream');
}

async function main() {
  await testHlsMasterVariants();
  await testHlsMediaAndDrmHint();
  await testDashMpdFormatsAndDrmHint();
  await testDashSubtitleVtt();
  await testDashSubtitleTtml();
  await testDashSubtitleLangFromContentType();
  await testHlsCodecLabels();
  await testDashCodecLabels();
  await testDashLiveStream();
  await testHlsImageStreamInf();
  await testDashAudioLanguage();
  await testHlsAudioLanguage();
  await testHlsAes128NotBlocked();
  await testDashMpdDuration();
  await testFailureReturnsOriginalShapeWithAudit();
  await testOversizedReturnsOriginalShapeWithAudit();
  await testUniversalOnlyIntegration();
  console.log('universal manifest inspector ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

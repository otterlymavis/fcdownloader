import './test_setup.js';
import assert from 'node:assert/strict';
import { DetectedMedia } from './src/types';
import { verifyUniversalDirectCandidates } from './src/lib/universalUrlVerifier';

function item(url: string, mediaType: DetectedMedia['mediaType'] = 'direct'): DetectedMedia {
  return {
    id: url,
    url,
    pageUrl: 'https://example.com/post',
    userAgent: '',
    timestamp: Date.now(),
    mediaType,
    mediaKind: 'video',
    confidence: 0.75,
    extractor: 'universal-probe',
  };
}

function headFetch(init: {
  status?: number;
  url?: string;
  contentType?: string;
  contentLength?: string;
  disposition?: string;
}): typeof fetch {
  return (async () => {
    const res = new Response(null, {
      status: init.status ?? 200,
      headers: {
        ...(init.contentType ? { 'Content-Type': init.contentType } : {}),
        ...(init.contentLength ? { 'Content-Length': init.contentLength } : {}),
        ...(init.disposition ? { 'Content-Disposition': init.disposition } : {}),
      },
    });
    Object.defineProperty(res, 'url', { value: init.url ?? 'https://cdn.example.com/final.mp4' });
    return res;
  }) as typeof fetch;
}

function headThenRangeFetch(): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') {
      return new Response(null, { status: 405 });
    }
    assert.equal(init?.method, 'GET');
    assert.equal((init?.headers as Record<string, string>)?.Range, 'bytes=0-0');
    const res = new Response(new Uint8Array([0]), {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': 'bytes 0-0/777777',
      },
    });
    Object.defineProperty(res, 'url', { value: 'https://cdn.example.com/range-final.mp4' });
    return res;
  }) as typeof fetch;
}

async function testVerifiedMediaCandidate() {
  const verified = await verifyUniversalDirectCandidates('universal-browser-probe', [
    item('https://cdn.example.com/video'),
  ], {
    fetchImpl: headFetch({
      contentType: 'video/mp4',
      contentLength: '2400000',
      disposition: 'attachment; filename="clip.mp4"',
    }),
  });

  assert.equal(verified.length, 1);
  assert.equal(verified[0].url, 'https://cdn.example.com/final.mp4');
  assert.equal(verified[0].mimeType, 'video/mp4');
  assert.equal(verified[0].mediaKind, 'video');
  assert.equal(verified[0].label, 'clip.mp4');
  assert(verified[0].confidence && verified[0].confidence >= 0.82);
  assert.equal(verified[0].sourceAudit?.at(-1)?.contentLength, 2_400_000);
}

async function testConfirmedNonMediaDropsCandidate() {
  const verified = await verifyUniversalDirectCandidates('universal-media-probe', [
    item('https://cdn.example.com/fake.mp4'),
  ], {
    fetchImpl: headFetch({ contentType: 'text/html; charset=utf-8' }),
  });

  assert.equal(verified.length, 0);
}

async function testHeadBlockedFallsBackToRangeGet() {
  const verified = await verifyUniversalDirectCandidates('universal-browser-probe', [
    item('https://cdn.example.com/head-blocked'),
  ], {
    fetchImpl: headThenRangeFetch(),
  });

  assert.equal(verified.length, 1);
  assert.equal(verified[0].url, 'https://cdn.example.com/range-final.mp4');
  assert.equal(verified[0].mimeType, 'video/mp4');
  assert.equal(verified[0].sourceAudit?.at(-1)?.status, 206);
  assert.equal(verified[0].sourceAudit?.at(-1)?.contentLength, 777777);
  assert.match(verified[0].sourceAudit?.at(-1)?.notes ?? '', /range fallback/i);
}

async function testFailureKeepsCandidateWithAudit() {
  const verified = await verifyUniversalDirectCandidates('universal-browser-probe', [
    item('https://cdn.example.com/video.mp4'),
  ], {
    fetchImpl: (async () => { throw new Error('network down'); }) as typeof fetch,
  });

  assert.equal(verified.length, 1);
  assert.equal(verified[0].url, 'https://cdn.example.com/video.mp4');
  assert.match(verified[0].sourceAudit?.at(-1)?.notes ?? '', /verification skipped/i);
}

async function testScopeAndManifestSkip() {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(null, { headers: { 'Content-Type': 'video/mp4' } });
  }) as typeof fetch;
  const nonUniversal = await verifyUniversalDirectCandidates('server-extraction', [item('https://cdn.example.com/video.mp4')], { fetchImpl });
  const manifest = await verifyUniversalDirectCandidates('universal-browser-probe', [item('https://cdn.example.com/master.m3u8', 'hls')], { fetchImpl });

  assert.equal(calls, 0);
  assert.equal(nonUniversal[0].url, 'https://cdn.example.com/video.mp4');
  assert.equal(manifest[0].mediaType, 'hls');
}

async function testSubtitleMimeClassification() {
  // text/vtt should not be dropped as non-media and should get mediaKind=subtitle
  const vttItems = await verifyUniversalDirectCandidates(
    'universal-browser-probe',
    [{ ...item('https://cdn.example.com/captions.vtt'), mediaKind: 'subtitle' }],
    { fetchImpl: headFetch({ contentType: 'text/vtt; charset=UTF-8', contentLength: '5000' }) },
  );
  assert.equal(vttItems.length, 1, 'text/vtt item should not be dropped');
  assert.equal(vttItems[0].mediaKind, 'subtitle');
  assert.equal(vttItems[0].mediaType, 'direct');

  // application/x-subrip (.srt) same treatment
  const srtItems = await verifyUniversalDirectCandidates(
    'universal-browser-probe',
    [{ ...item('https://cdn.example.com/subs.srt'), mediaKind: 'subtitle' }],
    { fetchImpl: headFetch({ contentType: 'application/x-subrip', contentLength: '3000' }) },
  );
  assert.equal(srtItems.length, 1, 'SRT subtitle should not be dropped');
  assert.equal(srtItems[0].mediaKind, 'subtitle');
}

async function main() {
  await testVerifiedMediaCandidate();
  await testConfirmedNonMediaDropsCandidate();
  await testHeadBlockedFallsBackToRangeGet();
  await testFailureKeepsCandidateWithAudit();
  await testScopeAndManifestSkip();
  await testSubtitleMimeClassification();
  console.log('universal URL verifier ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { XMLParser } from 'fast-xml-parser';
import { extractSessionCookies } from './cookieManager';
import { DetectedMedia } from '../types';
import { DownloadOptions } from './hlsDownloader';
import { muxVideoAudio } from './ffmpegMux';

const SEGMENT_BATCH = 3;
const MUX_CHUNK = 1024 * 1024;
const LARGE_FILE_STALL_MS = 30_000;
const LARGE_FILE_ATTEMPTS = 3;

// ── URL helpers ────────────────────────────────────────────────

function resolveUrl(url: string, base: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  try {
    const b = new URL(base);
    if (url.startsWith('//')) return `${b.protocol}${url}`;
    if (url.startsWith('/')) return `${b.protocol}//${b.host}${url}`;
    return base.slice(0, base.lastIndexOf('/') + 1) + url;
  } catch { return url; }
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function makeHeaders(cookies: string, ua: string, referer: string): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': ua, 'Accept': '*/*', 'Referer': referer };
  if (cookies) h['Cookie'] = cookies;
  return h;
}

// ── MPD parsing ────────────────────────────────────────────────

export interface Representation {
  id: string;
  bandwidth: number;
  width?: number;
  height?: number;
  mimeType?: string;
  codecs?: string;
  contentType: 'video' | 'audio' | 'unknown';
  initUrl?: string;
  segmentUrls: string[];
}

export interface ParsedMPD {
  video: Representation[];
  audio: Representation[];
}

export interface SelectedDashRepresentations {
  video?: Representation;
  audio?: Representation;
}

function expandTemplate(tpl: string, repId: string, num: number, time: number, bandwidth: number = 0): string {
  return tpl
    .replace(/\$RepresentationID\$/g, repId)
    .replace(/\$Number(?:%0?(\d+)d)?\$/g, (_, w) => w ? String(num).padStart(parseInt(w), '0') : String(num))
    .replace(/\$Time(?:%0?(\d+)d)?\$/g, (_, w) => w ? String(time).padStart(parseInt(w), '0') : String(time))
    .replace(/\$Bandwidth\$/g, String(bandwidth));
}

function parseIsoDuration(s: string): number {
  const m = s.match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/i);
  if (!m) return 0;
  return (parseFloat(m[1] ?? '0') * 3600) + (parseFloat(m[2] ?? '0') * 60) + parseFloat(m[3] ?? '0');
}

function resolveSegmentsFromTemplate(
  rep: Record<string, any>,
  segTemplate: Record<string, any>,
  baseUrl: string,
  mediaDurationSec: number = 3600,
): { initUrl?: string; segmentUrls: string[] } {
  const repId = String(rep['@_id'] ?? '');
  const bandwidth = parseInt(String(rep['@_bandwidth'] ?? '0'), 10);
  const mediaTpl = String(segTemplate['@_media'] ?? '');
  const initTpl = String(segTemplate['@_initialization'] ?? '');
  const startNumber = parseInt(String(segTemplate['@_startNumber'] ?? '1'), 10);
  const timescale = parseInt(String(segTemplate['@_timescale'] ?? '1'), 10);
  const durationAttr = parseInt(String(segTemplate['@_duration'] ?? '0'), 10);

  const initUrl = initTpl ? resolveUrl(expandTemplate(initTpl, repId, 0, 0, bandwidth), baseUrl) : undefined;
  const segments: string[] = [];
  const timeline = segTemplate.SegmentTimeline;

  if (timeline) {
    let segNum = startNumber;
    let t = 0;
    for (const s of toArray(timeline.S)) {
      const segT = parseInt(String(s['@_t'] ?? String(t)), 10);
      const d = parseInt(String(s['@_d'] ?? '0'), 10);
      const r = parseInt(String(s['@_r'] ?? '0'), 10);
      t = segT;
      for (let i = 0; i <= r; i++) {
        segments.push(resolveUrl(expandTemplate(mediaTpl, repId, segNum, t, bandwidth), baseUrl));
        t += d;
        segNum++;
      }
    }
  } else if (durationAttr > 0) {
    const maxSegs = Math.ceil((mediaDurationSec * timescale) / durationAttr);
    for (let i = 0; i < maxSegs; i++) {
      segments.push(resolveUrl(expandTemplate(mediaTpl, repId, startNumber + i, 0, bandwidth), baseUrl));
    }
  }

  return { initUrl, segmentUrls: segments };
}

export function parseMPD(xml: string, mpdUrl: string): ParsedMPD {
  const FORCE_ARRAYS = new Set(['AdaptationSet', 'Representation', 'SegmentURL', 'S', 'Period', 'BaseURL']);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (tagName: string) => FORCE_ARRAYS.has(tagName),
  });

  const doc = parser.parse(xml);
  const mpd = doc?.MPD ?? doc;
  const baseUrlBase: string = (() => {
    try {
      const u = new URL(mpdUrl);
      return `${u.protocol}//${u.host}${u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1)}`;
    } catch { return mpdUrl; }
  })();

  const mpdBaseRaw = toArray(mpd.BaseURL)[0] ?? '';
  const resolvedBase = mpdBaseRaw ? resolveUrl(String(mpdBaseRaw), baseUrlBase) : baseUrlBase;
  const mediaDurationSec = parseIsoDuration(String(mpd['@_mediaPresentationDuration'] ?? '')) || 3600;
  const result: ParsedMPD = { video: [], audio: [] };

  for (const period of toArray(mpd.Period)) {
    const periodBase = resolveUrl(String(toArray(period.BaseURL)[0] ?? ''), resolvedBase) || resolvedBase;

    for (const as of toArray(period.AdaptationSet)) {
      const asMime: string = String(as['@_mimeType'] ?? as['@_contentType'] ?? '').toLowerCase();
      const asBase = resolveUrl(String(toArray(as.BaseURL)[0] ?? ''), periodBase) || periodBase;
      const asTpl: Record<string, any> | undefined = as.SegmentTemplate ?? undefined;

      for (const rep of toArray(as.Representation)) {
        const repMime = String(rep['@_mimeType'] ?? asMime).toLowerCase();
        const contentType: 'video' | 'audio' | 'unknown' =
          repMime.includes('video') ? 'video'
          : repMime.includes('audio') ? 'audio'
          : asMime.includes('video') ? 'video'
          : asMime.includes('audio') ? 'audio'
          : 'unknown';

        const repBase = resolveUrl(String(toArray(rep.BaseURL)[0] ?? ''), asBase) || asBase;

        let initUrl: string | undefined;
        let segmentUrls: string[] = [];

        if (rep.SegmentBase || as.SegmentBase) {
          segmentUrls = repBase ? [repBase] : [];
        } else if (rep.SegmentTemplate) {
          const r = resolveSegmentsFromTemplate(rep, rep.SegmentTemplate, repBase || asBase, mediaDurationSec);
          initUrl = r.initUrl; segmentUrls = r.segmentUrls;
        } else if (asTpl) {
          const r = resolveSegmentsFromTemplate(rep, asTpl, repBase || asBase, mediaDurationSec);
          initUrl = r.initUrl; segmentUrls = r.segmentUrls;
        } else if (rep.SegmentList || as.SegmentList) {
          const sl = rep.SegmentList ?? as.SegmentList;

          // Initialization — may use sourceURL or a byte-range on the BaseURL
          if (sl.Initialization) {
            const initSrc   = String(sl.Initialization['@_sourceURL'] ?? '');
            const initRange = String(sl.Initialization['@_range']     ?? '');
            if (initSrc) {
              initUrl = resolveUrl(initSrc, repBase || asBase);
            } else if (initRange && (repBase || asBase)) {
              const base = repBase || asBase;
              initUrl = `${base}${base.includes('?') ? '&' : '?'}range=${initRange}`;
            }
          }

          // Segments — may use separate media URLs or byte-ranges on the BaseURL
          segmentUrls = toArray(sl.SegmentURL).map((s: any) => {
            const media      = String(s['@_media']      ?? '');
            const mediaRange = String(s['@_mediaRange'] ?? '');
            const base = repBase || asBase;
            if (media) return resolveUrl(media, base);
            if (mediaRange && base)
              return `${base}${base.includes('?') ? '&' : '?'}range=${mediaRange}`;
            return '';
          }).filter(Boolean);
        } else if (repBase) {
          segmentUrls = [repBase];
        }

        if (segmentUrls.length === 0 && !initUrl) continue;

        const r: Representation = {
          id: String(rep['@_id'] ?? ''),
          bandwidth: parseInt(String(rep['@_bandwidth'] ?? '0'), 10),
          width: rep['@_width'] ? parseInt(String(rep['@_width']), 10) : undefined,
          height: rep['@_height'] ? parseInt(String(rep['@_height']), 10) : undefined,
          mimeType: repMime || undefined,
          codecs: String(rep['@_codecs'] ?? as['@_codecs'] ?? '') || undefined,
          contentType,
          initUrl,
          segmentUrls,
        };

        if (contentType === 'video' || contentType === 'unknown') result.video.push(r);
        if (contentType === 'audio') result.audio.push(r);
      }
    }
  }

  result.video.sort((a, b) => b.bandwidth - a.bandwidth);
  result.audio.sort((a, b) => b.bandwidth - a.bandwidth);
  return result;
}

export function selectDashRepresentations(
  parsed: ParsedMPD,
  media: Pick<DetectedMedia, 'formatId' | 'availableFormats'>,
): SelectedDashRepresentations {
  const selectedFormat = media.formatId
    ? media.availableFormats?.find((format) => format.id === media.formatId)
    : undefined;
  const audioFormatId = selectedFormat?.audioFormatId;
  const video = media.formatId
    ? parsed.video.find((rep) => rep.id === media.formatId)
    : parsed.video[0];
  if (media.formatId && !video) {
    throw new Error(`Requested DASH video representation not found: ${media.formatId}`);
  }
  const audio = audioFormatId
    ? parsed.audio.find((rep) => rep.id === audioFormatId)
    : parsed.audio[0];
  if (audioFormatId && !audio) {
    throw new Error(`Requested DASH audio representation not found: ${audioFormatId}`);
  }
  return { video, audio };
}

// ── Segment download helpers ───────────────────────────────────

async function downloadSegment(
  url: string, destPath: string, headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const res = await expoFetch(url, { signal, headers });
  if (signal?.aborted) throw new Error('Cancelled');
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url.split('?')[0].split('/').pop()}`);
  const bytes = await res.bytes();
  if (signal?.aborted) throw new Error('Cancelled');
  const file = new File(destPath);
  file.create({ intermediates: true, overwrite: true });
  file.write(bytes);
}

async function downloadTrack(
  segments: string[], initUrl: string | undefined,
  dir: string, prefix: string,
  headers: Record<string, string>,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const outPath = `${FileSystem.documentDirectory}downloads/${dir}/${prefix}.mp4`;
  const outFile = new File(outPath);
  outFile.create({ intermediates: true, overwrite: true });
  const handle = outFile.open();

  try {
    if (initUrl) {
      const initPath = `${FileSystem.documentDirectory}downloads/${dir}/${prefix}_init.mp4`;
      await downloadSegment(initUrl, initPath, headers, signal);
      const initFile = new File(initPath);
      const h = initFile.open();
      try {
        while ((h.offset ?? 0) < (h.size ?? 0)) {
          const rem = (h.size ?? 0) - (h.offset ?? 0);
          handle.writeBytes(h.readBytes(Math.min(MUX_CHUNK, rem)));
        }
      } finally { h.close(); }
    }

    const total = segments.length;
    for (let i = 0; i < total; i += SEGMENT_BATCH) {
      if (signal?.aborted) throw new Error('Cancelled');
      const batch = segments.slice(i, i + SEGMENT_BATCH);
      const paths = await Promise.all(batch.map(async (url, j) => {
        const segPath = `${FileSystem.documentDirectory}downloads/${dir}/${prefix}_seg${String(i + j).padStart(6, '0')}.m4s`;
        await downloadSegment(url, segPath, headers, signal);
        return segPath;
      }));
      for (const p of paths) {
        const seg = new File(p);
        const h = seg.open();
        try {
          while ((h.offset ?? 0) < (h.size ?? 0)) {
            const rem = (h.size ?? 0) - (h.offset ?? 0);
            handle.writeBytes(h.readBytes(Math.min(MUX_CHUNK, rem)));
          }
        } finally { h.close(); }
      }
      onProgress?.(Math.min(i + SEGMENT_BATCH, total), total);
    }
  } finally {
    handle.close();
  }

  return outPath;
}

// ── Large-file download (resumable, for Bilibili etc.) ─────────

async function downloadLargeFile(
  url: string, destPath: string,
  headers: Record<string, string>,
  onProgress?: (written: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  let resumeData: string | undefined;
  let lastErr: Error = new Error('DASH track download failed');

  for (let attempt = 0; attempt < LARGE_FILE_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error('Cancelled');
    let aborted = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let resumable: ReturnType<typeof FileSystem.createDownloadResumable>;

    const clearStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = undefined;
    };

    const armStallTimer = (reject: (err: Error) => void) => {
      clearStallTimer();
      stallTimer = setTimeout(() => {
        resumable.pauseAsync()
          .then((state) => { resumeData = state.resumeData; })
          .catch(() => {})
          .finally(() => reject(new Error('DASH download stalled')));
      }, LARGE_FILE_STALL_MS);
    };

    try {
      const stalled = new Promise<never>((_, reject) => {
        resumable = FileSystem.createDownloadResumable(
          url, destPath, { headers },
          ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
            if (totalBytesExpectedToWrite > 0) onProgress?.(totalBytesWritten, totalBytesExpectedToWrite);
            armStallTimer(reject);
          },
          resumeData,
        );
        armStallTimer(reject);
      });

      const abortHandler = () => {
        aborted = true;
        resumable.pauseAsync()
          .then((state) => { resumeData = state.resumeData; })
          .catch(() => {});
      };
      signal?.addEventListener('abort', abortHandler);

      try {
        const result = await Promise.race([resumable!.downloadAsync(), stalled]);
        if (aborted || signal?.aborted) throw new Error('Cancelled');
        if (!result || result.status < 200 || result.status >= 300) {
          throw new Error(`HTTP ${result?.status ?? 'unknown'} downloading track`);
        }
        return;
      } finally {
        clearStallTimer();
        signal?.removeEventListener('abort', abortHandler);
      }
    } catch (err) {
      lastErr = err as Error;
      if (signal?.aborted || lastErr.message === 'Cancelled') throw lastErr;
      if (/HTTP [234]\d\d/.test(lastErr.message) || attempt === LARGE_FILE_ATTEMPTS - 1) {
        throw lastErr;
      }
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }

  throw lastErr;
}

// ── Main entry point ───────────────────────────────────────────

export async function downloadDASH(
  media: DetectedMedia,
  taskId: string,
  opts: DownloadOptions = {},
): Promise<string> {
  const { signal, onStatus, onProgress } = opts;

  const ua = media.userAgent || 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36';
  const dir = `${FileSystem.documentDirectory}downloads/${taskId}/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

  // When the extractor stored headers (e.g. YouTube CDN context), use them verbatim
  // for every request. Otherwise build from session cookies as before.
  const buildFallback = async (skipCookies: boolean): Promise<Record<string, string>> => {
    const cookies = skipCookies ? '' : await extractSessionCookies(media.pageUrl);
    return makeHeaders(cookies, ua, media.pageUrl);
  };
  const buildHeaders = async (url: string): Promise<Record<string, string>> => {
    const skipCookies = /googlevideo\.com/i.test(url);
    if (media.httpHeaders) {
      const headers = { ...media.httpHeaders };
      const hasCookie = Object.keys(headers).some((k) => k.toLowerCase() === 'cookie');
      if (!hasCookie && !skipCookies) {
        const cookies = await extractSessionCookies(media.pageUrl);
        if (cookies) headers['Cookie'] = cookies;
      }
      return headers;
    }
    return buildFallback(skipCookies);
  };

  // ── Case 1: Paired tracks — download both, mux with ffmpeg ─────
  // Progress: 0–45% video, 45–90% audio, 90–100% mux.
  if (media.audioTrackUrl) {
    const headers = await buildHeaders(media.url);
    const videoPath  = `${dir}video.track.mp4`;
    const audioPath  = `${dir}audio.track.m4a`;
    const outputPath = `${dir}video.mp4`;

    onStatus?.('downloading');
    await downloadLargeFile(media.url, videoPath, headers,
      (w, t) => onProgress?.(Math.floor(w * 0.45), t || 1),
      signal,
    );
    if (signal?.aborted) throw new Error('Cancelled');

    await downloadLargeFile(media.audioTrackUrl, audioPath, headers,
      (w, t) => onProgress?.(Math.floor((t || 1) * 0.45 + w * 0.45), t || 1),
      signal,
    );
    if (signal?.aborted) throw new Error('Cancelled');

    const vInfo = await FileSystem.getInfoAsync(videoPath);
    const aInfo = await FileSystem.getInfoAsync(audioPath);
    if (!vInfo.exists || (vInfo.size ?? 0) === 0) throw new Error('Video track is empty');
    if (!aInfo.exists || (aInfo.size ?? 0) === 0) throw new Error('Audio track is empty');

    onStatus?.('assembling');
    onProgress?.(90, 100);
    // FFmpegKit needs filesystem paths without the file:// prefix
    const strip = (p: string) => p.replace(/^file:\/\//, '');
    await muxVideoAudio(strip(videoPath), strip(audioPath), strip(outputPath));

    // Best-effort cleanup of the intermediate tracks
    try { await FileSystem.deleteAsync(videoPath, { idempotent: true }); } catch {}
    try { await FileSystem.deleteAsync(audioPath, { idempotent: true }); } catch {}

    const outInfo = await FileSystem.getInfoAsync(outputPath);
    if (!outInfo.exists || (outInfo.size ?? 0) === 0) throw new Error('Muxed file is empty');
    onProgress?.(1, 1);
    return outputPath;
  }

  // ── Case 2: DASH MPD manifest URL ────────────────────────────
  onStatus?.('fetching_manifest');

  const manifestHeaders = await buildHeaders(media.url);
  let mpdUrl = media.url;
  let mpdRes = await fetch(mpdUrl, { signal, headers: manifestHeaders });
  if (!mpdRes.ok) {
    if (mpdRes.status === 403 && opts.onTokenExpired) {
      const freshUrl = await opts.onTokenExpired(mpdUrl);
      if (freshUrl) {
        mpdUrl = freshUrl;
        mpdRes = await fetch(mpdUrl, { signal, headers: manifestHeaders });
      }
    }
    if (!mpdRes.ok) throw new Error(`HTTP ${mpdRes.status} fetching MPD manifest`);
  }
  const mpdXml = (await mpdRes.text()) ?? '';
  if (signal?.aborted) throw new Error('Cancelled');

  if (!mpdXml.includes('<MPD') && !mpdXml.includes('urn:mpeg:dash')) {
    throw new Error('Response is not a DASH manifest — URL may have expired or require login');
  }

  const parsed = parseMPD(mpdXml, media.url);

  if (parsed.video.length === 0 && parsed.audio.length === 0) {
    throw new Error('No playable tracks found in DASH manifest');
  }

  const { video: selectedVideo, audio: selectedAudio } = selectDashRepresentations(parsed, media);
  const shouldMuxSelectedAudio = !!selectedVideo && !!selectedAudio && (media.extractor === 'universal-probe' || !!media.formatId);
  const isSingleFileTrack = (track: Representation | undefined) =>
    !!track && track.segmentUrls.length === 1 && !track.initUrl;

  if (shouldMuxSelectedAudio) {
    const videoPath = `${dir}video.track.mp4`;
    const audioPath = `${dir}audio.track.m4a`;
    const outputPath = `${dir}video.mp4`;

    onStatus?.('downloading');
    if (isSingleFileTrack(selectedVideo)) {
      const headers = await buildHeaders(selectedVideo.segmentUrls[0]);
      await downloadLargeFile(selectedVideo.segmentUrls[0], videoPath, headers,
        (w, t) => onProgress?.(Math.floor(w * 0.45), t || 1),
        signal,
      );
    } else {
      const firstSeg = selectedVideo.segmentUrls[0] ?? selectedVideo.initUrl ?? '';
      const headers = await buildHeaders(firstSeg);
      await downloadTrack(
        selectedVideo.segmentUrls,
        selectedVideo.initUrl,
        taskId,
        'video_track',
        headers,
        (done, total) => onProgress?.(done, Math.max(total * 2, 1)),
        signal,
      );
    }
    if (signal?.aborted) throw new Error('Cancelled');

    if (isSingleFileTrack(selectedAudio)) {
      const headers = await buildHeaders(selectedAudio.segmentUrls[0]);
      await downloadLargeFile(selectedAudio.segmentUrls[0], audioPath, headers,
        (w, t) => onProgress?.(Math.floor((t || 1) * 0.45 + w * 0.45), t || 1),
        signal,
      );
    } else {
      const firstSeg = selectedAudio.segmentUrls[0] ?? selectedAudio.initUrl ?? '';
      const headers = await buildHeaders(firstSeg);
      await downloadTrack(
        selectedAudio.segmentUrls,
        selectedAudio.initUrl,
        taskId,
        'audio_track',
        headers,
        (done, total) => onProgress?.(Math.max(selectedVideo.segmentUrls.length, 1) + done, Math.max(selectedVideo.segmentUrls.length + total, 1)),
        signal,
      );
    }
    if (signal?.aborted) throw new Error('Cancelled');

    const vInfo = await FileSystem.getInfoAsync(videoPath);
    const aInfo = await FileSystem.getInfoAsync(audioPath);
    if (!vInfo.exists || (vInfo.size ?? 0) === 0) throw new Error('Video track is empty');
    if (!aInfo.exists || (aInfo.size ?? 0) === 0) throw new Error('Audio track is empty');

    onStatus?.('assembling');
    onProgress?.(90, 100);
    const strip = (p: string) => p.replace(/^file:\/\//, '');
    await muxVideoAudio(strip(videoPath), strip(audioPath), strip(outputPath));
    try { await FileSystem.deleteAsync(videoPath, { idempotent: true }); } catch {}
    try { await FileSystem.deleteAsync(audioPath, { idempotent: true }); } catch {}
    const outInfo = await FileSystem.getInfoAsync(outputPath);
    if (!outInfo.exists || (outInfo.size ?? 0) === 0) throw new Error('Muxed file is empty');
    onProgress?.(1, 1);
    return outputPath;
  }

  // ── Case 2a: SegmentBase (single-URL byte-range track) — download directly ──
  const isSegmentBase = isSingleFileTrack(selectedVideo) || (!selectedVideo && isSingleFileTrack(selectedAudio));
  if (isSegmentBase) {
    const trackUrl = selectedVideo?.segmentUrls[0] ?? selectedAudio?.segmentUrls[0] ?? '';
    if (!trackUrl) throw new Error('No segment URL in SegmentBase track');
    onStatus?.('downloading');
    const outPath = `${dir}video.mp4`;
    const sbHeaders = await buildHeaders(trackUrl);
    await downloadLargeFile(trackUrl, outPath, sbHeaders,
      (w, t) => onProgress?.(w, t), signal);
    if (signal?.aborted) throw new Error('Cancelled');
    const info = await FileSystem.getInfoAsync(outPath);
    if (!info.exists || (info.size ?? 0) === 0) {
      throw new Error('Downloaded file is empty — stream may require authentication or has expired');
    }
    onProgress?.(1, 1);
    return outPath;
  }

  // ── Case 2b: SegmentTemplate / SegmentList — download best available track ──
  // Try tracks from highest to lowest quality; skip a track if its first segment
  // returns HTTP 404 (stale CDN segment rotation is common for public test streams).
  onStatus?.('downloading');
  const candidates = media.formatId && selectedVideo
    ? [selectedVideo]
    : parsed.video.length > 0 ? parsed.video : selectedAudio ? [selectedAudio] : [];
  let lastErr: Error = new Error('No video track had accessible segments');
  for (const track of candidates) {
    if (signal?.aborted) throw new Error('Cancelled');
    const totalSegs = track.segmentUrls.length;
    const firstSeg = track.segmentUrls[0] ?? track.initUrl ?? '';
    const segHeaders = await buildHeaders(firstSeg);
    try {
      const outPath = await downloadTrack(
        track.segmentUrls, track.initUrl, taskId, 'video_track',
        segHeaders,
        (done) => onProgress?.(done, totalSegs),
        signal,
      );
      onStatus?.('assembling');
      const info = await FileSystem.getInfoAsync(outPath);
      if (!info.exists || (info.size ?? 0) === 0) throw new Error('Downloaded track is empty');
      onProgress?.(1, 1);
      return outPath;
    } catch (err) {
      lastErr = err as Error;
      if (signal?.aborted || lastErr.message === 'Cancelled') throw lastErr;
      if (!/HTTP 404/.test(lastErr.message)) throw lastErr;
    }
  }
  throw lastErr;
}

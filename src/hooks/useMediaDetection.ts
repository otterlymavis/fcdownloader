import { useCallback, useRef, useState } from 'react';
import { WebViewMessageEvent } from 'react-native-webview';
import { DetectedMedia, MediaType, Provenance } from '../types';

let _seq = 0;
const genId = () => `media_${Date.now()}_${_seq++}`;

function guessType(url: string): MediaType {
  const u = url.toLowerCase();
  if (u.includes('.mpd')) return 'dash';
  if (u.includes('.m3u8')) return 'hls';
  return 'direct';
}

function guessKind(url: string, mimeType?: string | null): DetectedMedia['mediaKind'] {
  const u = url.toLowerCase().split('?')[0];
  const mt = String(mimeType || '').toLowerCase();
  if (mt.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|heic)$/.test(u)) return 'image';
  if (mt.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/.test(u)) return 'audio';
  return 'video';
}

function isSegmentUrl(url: string): boolean {
  const clean = url.split('#')[0].split('?')[0].toLowerCase();
  const lower = url.toLowerCase();
  // YouTube adaptive segment requests (byte-range AND sequence-number variants)
  if (/googlevideo\.com\/videoplayback/i.test(url) &&
      /[?&](?:range=|sq=)\d/i.test(url)) return true;
  return /\.(ts|m4s|aac|m4a|cmfv|cmfa)$/.test(clean) ||
    (lower.includes('vimeocdn.com/') && lower.includes('/v2/range/') && lower.includes('/avf/'));
}

export function useMediaDetection() {
  const [detected, setDetected]     = useState<DetectedMedia[]>([]);
  const [networkLog, setNetworkLog] = useState<string[]>([]);
  const [mseActive, setMseActive]   = useState(false);
  const [scanDone, setScanDone]     = useState(false);
  const [bridgeOk, setBridgeOk]     = useState(false);
  const currentPageUrl = useRef('');

  const onPageChange = useCallback((url: string) => {
    currentPageUrl.current = url;
    setDetected([]);
    setNetworkLog([]);
    setMseActive(false);
    setScanDone(false);
  }, []);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.event === 'BRIDGE_READY') {
        setBridgeOk(true);
        return;
      }

      if (data.event === 'PAGE_NAVIGATE') {
        // SPA navigation detected — reset detection state for new page
        const newUrl = String(data.url ?? '').trim();
        if (newUrl && newUrl !== currentPageUrl.current) {
          currentPageUrl.current = newUrl;
          setDetected([]);
          setNetworkLog([]);
          setMseActive(false);
          setScanDone(false);
        }
        return;
      }

      if (data.event === 'MEDIA_DETECTED') {
        const url = String(data.url ?? '').trim();
        if (!url || isSegmentUrl(url)) return;
        const item: DetectedMedia = {
          id: genId(),
          url,
          pageUrl: (data.pageUrl as string) ?? currentPageUrl.current,
          userAgent: (data.userAgent as string) ?? '',
          timestamp: (data.timestamp as number) ?? Date.now(),
          mimeType: data.mimeType ?? undefined,
          mediaType: (data.mediaType as MediaType) ?? guessType(url),
          mediaKind: data.mediaKind ?? guessKind(url, data.mimeType),
          label: data.label ?? undefined,
          confidence: typeof data.confidence === 'number' ? data.confidence : 0.5,
          provenance: (data.provenance as Provenance) ?? 'perf-observer',
          // Bilibili and other paired-track streams
          audioTrackUrl: data.audioTrackUrl ?? undefined,
          audioTrackCodecs: data.audioTrackCodecs ?? undefined,
          width: typeof data.width === 'number' ? data.width : undefined,
          height: typeof data.height === 'number' ? data.height : undefined,
          bitrate: typeof data.bitrate === 'number' ? data.bitrate : undefined,
          codecs: data.codecs ?? undefined,
          hasAudio: data.hasAudio ?? undefined,
          hasVideo: data.hasVideo ?? undefined,
        };
        setDetected((prev) => {
          const idx = prev.findIndex((m) => m.url === url);
          if (idx === -1) return [item, ...prev];
          // Upgrade confidence in-place if a higher-confidence event arrives
          if ((item.confidence ?? 0) > (prev[idx].confidence ?? 0)) {
            const updated = [...prev];
            updated[idx] = {
              ...prev[idx],
              confidence:    item.confidence,
              provenance:    item.provenance,
              // Upgrade type/mime when a higher-confidence source corrects them
              mediaType:     item.mediaType    ?? prev[idx].mediaType,
              mediaKind:     item.mediaKind    ?? prev[idx].mediaKind,
              mimeType:      item.mimeType     ?? prev[idx].mimeType,
              audioTrackUrl: item.audioTrackUrl ?? prev[idx].audioTrackUrl,
              width:         item.width         ?? prev[idx].width,
              height:        item.height        ?? prev[idx].height,
            };
            return updated;
          }
          return prev;
        });
        return;
      }

      if (data.event === 'URL_CAPTURED') {
        const url = String(data.url ?? '').trim();
        if (!url) return;
        setNetworkLog((prev) => {
          if (prev.includes(url)) return prev;
          return [url, ...prev].slice(0, 500);
        });
        // Auto-promote manifests, direct media files, and known media CDN URLs
        const u = url.toLowerCase();
        const isManifest  = /\.m3u8/i.test(url) || /\.mpd/i.test(url);
        const isVimeoJson = /vimeocdn\.com\/.*\/playlist\.json(\?|$)/i.test(url);
        const isDirectMedia = /\.(mp4|m4v|webm|mov|jpe?g|png|webp|gif|avif|heic|mp3|m4a|aac|wav|ogg|opus|flac)(\?|$)/i.test(url) &&
          !/vimeocdn\.com\/.*\/v2\/range\//i.test(url);
        const isCdnVideo  = /(?:googlevideo\.com\/videoplayback|video\.twimg\.com\/|cdninstagram\.com\/|scontent[-\w]*\.cdninstagram\.com\/|fbcdn\.net\/|threadscdn\.com\/|tiktokcdn\.com\/|tiktokcdn-us\.com\/|v\d+-webapp\.tiktok\.com\/|v\.redd\.it\/|pinimg\.com\/videos\/|dmcdn\.net\/|usher\.twitch\.tv\/|bilivideo\.com\/|weibocdn\.com\/|xhscdn\.com\/)/i.test(url);
        const isImageCdn = /(?:cdninstagram\.com\/|scontent[-\w]*\.cdninstagram\.com\/|fbcdn\.net\/|threadscdn\.com\/|pinimg\.com\/(?:originals|736x|1200x|564x)\/|sinaimg\.cn\/|xhscdn\.com\/)/i.test(url);
        if (isManifest || isVimeoJson || isDirectMedia || isCdnVideo || isImageCdn) {
          const mediaType: MediaType = guessType(url);
          setDetected((prev) => {
            if (prev.some((m) => m.url === url)) return prev;
            return [{
              id: genId(), url,
              pageUrl: currentPageUrl.current,
              userAgent: '',
              timestamp: Date.now(),
              mediaType,
              mediaKind: guessKind(url),
              confidence: 0.4,
              provenance: 'perf-observer' as const,
            }, ...prev];
          });
        }
        return;
      }

      if (data.event === 'YT_DETECTED') {
        // Telemetry from the injected script's YouTube extractor.
        // Useful for debugging; no state change needed.
        if (__DEV__) {
          console.log('[YT]', {
            videoId:      data.videoId,
            formats:      data.formatsCount,
            adaptive:     data.adaptiveCount,
            hasDirect:    data.hasDirect,
            hasDash:      data.hasDash,
            hasHls:       data.hasHls,
            isIOS:        data.isIOS,
            emitted:      data.emitted,
          });
        }
        return;
      }

      if (data.event === 'MSE_STREAM' || data.event === 'MSE_ACTIVE') {
        setMseActive(true);
        return;
      }

      if (data.event === 'MSE_TRACK') {
        // MSE codec info — could enhance display later
        setMseActive(true);
        return;
      }

      if (data.event === 'SCAN_DONE') {
        setScanDone(true);
        return;
      }
    } catch {}
  }, []);

  const addDetected = useCallback((url: string, pageUrl?: string) => {
    url = url.trim();
    if (!url) return false;
    if (!url.startsWith('http')) return false;
    if (isSegmentUrl(url)) return false;
    setDetected((prev) => {
      if (prev.some((m) => m.url === url)) return false as any;
      return [{
        id: genId(), url,
        pageUrl: pageUrl ?? currentPageUrl.current,
        userAgent: '',
        timestamp: Date.now(),
        mediaType: guessType(url),
        mediaKind: guessKind(url),
        confidence: 0.75,
        provenance: 'manual' as const,
      }, ...prev];
    });
    return true;
  }, []);

  const dismiss = useCallback((id: string) => {
    setDetected((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const clear = useCallback(() => {
    setDetected([]);
    setNetworkLog([]);
    setMseActive(false);
    setScanDone(false);
  }, []);

  return {
    detected, networkLog, mseActive, scanDone, bridgeOk,
    onPageChange, onMessage, addDetected, dismiss, clear,
  };
}

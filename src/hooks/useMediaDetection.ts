import { useCallback, useRef, useState } from 'react';
import { WebViewMessageEvent } from 'react-native-webview';
import { DetectedMedia, MediaType } from '../types';

let _seq = 0;
const genId = () => `media_${Date.now()}_${_seq++}`;

function guessType(url: string): MediaType {
  return url.toLowerCase().includes('.mpd') ? 'dash' : 'hls';
}

function isSegmentUrl(url: string): boolean {
  const clean = url.split('#')[0].split('?')[0].toLowerCase();
  const lower = url.toLowerCase();
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
          mediaType: (data.mediaType as MediaType) ?? 'hls',
        };
        setDetected((prev) => prev.some((m) => m.url === url) ? prev : [item, ...prev]);
        return;
      }

      if (data.event === 'URL_CAPTURED') {
        const url = String(data.url ?? '').trim();
        if (!url) return;
        setNetworkLog((prev) => {
          if (prev.includes(url)) return prev;
          return [url, ...prev].slice(0, 500);
        });
        // Auto-promote manifests, direct video files, and known video CDN URLs
        const u = url.toLowerCase();
        const isManifest  = /\.m3u8/i.test(url) || /\.mpd/i.test(url);
        const isVimeoJson = /vimeocdn\.com\/.*\/playlist\.json(\?|$)/i.test(url);
        const isDirectMp4 = /\.(mp4|m4v|webm|mov)(\?|$)/i.test(url) &&
          !/vimeocdn\.com\/.*\/v2\/range\//i.test(url);
        const isCdnVideo  = /(?:googlevideo\.com\/videoplayback|video\.twimg\.com\/|cdninstagram\.com\/|scontent[-\w]*\.cdninstagram\.com\/|tiktokcdn\.com\/|tiktokcdn-us\.com\/|v\d+-webapp\.tiktok\.com\/|v\.redd\.it\/|pinimg\.com\/videos\/|dmcdn\.net\/|usher\.twitch\.tv\/)/i.test(url);
        if (isManifest || isVimeoJson || isDirectMp4 || isCdnVideo) {
          const mediaType: MediaType = u.includes('.mpd') ? 'dash' : 'hls';
          setDetected((prev) => {
            if (prev.some((m) => m.url === url)) return prev;
            return [{
              id: genId(), url,
              pageUrl: currentPageUrl.current,
              userAgent: '',
              timestamp: Date.now(),
              mediaType,
            }, ...prev];
          });
        }
        return;
      }

      if (data.event === 'MSE_STREAM' || data.event === 'BLOB_URL_CREATED') {
        setMseActive(true);
        return;
      }

      if (data.event === 'SCAN_DONE') {
        setScanDone(true);
        return;
      }
    } catch {}
  }, []);

  // Add a manually-typed or source-scanned URL as a detected item
  const addDetected = useCallback((url: string, pageUrl?: string) => {
    url = url.trim();
    if (!url) return false;
    if (!url.startsWith('http')) return false;
    if (isSegmentUrl(url)) return false;
    setDetected((prev) => {
      if (prev.some((m) => m.url === url)) return prev;
      return [{
        id: genId(),
        url,
        pageUrl: pageUrl ?? currentPageUrl.current,
        userAgent: '',
        timestamp: Date.now(),
        mediaType: guessType(url),
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

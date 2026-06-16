import { useCallback, useEffect, useRef, useState } from 'react';
import { WebViewMessageEvent } from 'react-native-webview';
import { DetectedMedia, MediaType, Provenance, SourceAuditEntry } from '../types';
import { debugLog } from '../lib/releaseLogger';
import {
  isLikelyThumbnailUrl,
  isNonContentMediaUrl,
  isRuntimeDownloadCandidate,
  isXhsPageUrl,
  isXhsMediaCandidate,
  isSegmentMediaUrl,
} from '../lib/mediaHelpers';
import { extractHtmlAuditCandidates, mediaHintsFromDetected, mediaHintsFromNetworkLog } from '../lib/browserSessionStrategies';

let _seq = 0;
const genId = () => `media_${Date.now()}_${_seq++}`;
const SESSION_SNAPSHOT_TIMEOUT_MS = 1500;

export interface BrowserSessionSnapshot {
  pageUrl?: string;
  referer?: string;
  cookies?: string;
  pageHtml?: string;
  mediaHints?: Array<Record<string, unknown>>;
  sourceAudit?: SourceAuditEntry[];
}

export interface BrowserNetworkEntry {
  url: string;
  pageUrl?: string;
  method?: string;
  status?: number;
  mimeType?: string;
  contentLength?: number;
  transferSize?: number;
  encodedBodySize?: number;
  provenance?: Provenance;
  initiatorType?: string;
  timestamp?: number;
}

function guessType(url: string): MediaType {
  const u = url.toLowerCase();
  if (u.includes('.mpd')) return 'dash';
  if (u.includes('.m3u8') || u.includes('.m3u')) return 'hls';
  return 'direct';
}

function guessKind(url: string, mimeType?: string | null): DetectedMedia['mediaKind'] {
  const u = url.toLowerCase().split('?')[0];
  const mt = String(mimeType || '').toLowerCase();
  if (mt.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|heic)$/.test(u)) return 'image';
  if (mt.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/.test(u)) return 'audio';
  return 'video';
}

export function useMediaDetection() {
  const [detected, setDetected]     = useState<DetectedMedia[]>([]);
  const [networkLog, setNetworkLog] = useState<BrowserNetworkEntry[]>([]);
  const [mseActive, setMseActive]   = useState(false);
  const [scanDone, setScanDone]     = useState(false);
  const [bridgeOk, setBridgeOk]     = useState(false);
  const currentPageUrl = useRef('');
  const detectedRef = useRef<DetectedMedia[]>([]);
  const networkLogRef = useRef<BrowserNetworkEntry[]>([]);
  const pendingSnapshots = useRef(new Map<string, {
    resolve: (snapshot: BrowserSessionSnapshot) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());

  useEffect(() => { detectedRef.current = detected; }, [detected]);
  useEffect(() => { networkLogRef.current = networkLog; }, [networkLog]);

  const onPageChange = useCallback((url: string) => {
    currentPageUrl.current = url;
    setDetected([]);
    setNetworkLog([]);
    setMseActive(false);
    setScanDone(false);
  }, []);

  const buildSessionSnapshot = useCallback((pageData: BrowserSessionSnapshot = {}): BrowserSessionSnapshot => {
    const pageUrl = pageData.pageUrl || currentPageUrl.current || '';
    const mediaHints = [
      ...mediaHintsFromDetected(detectedRef.current, pageUrl),
      ...mediaHintsFromNetworkLog(networkLogRef.current, pageUrl),
    ];
    const htmlAudit = extractHtmlAuditCandidates(pageUrl, pageData.pageHtml);
    const networkAudit: SourceAuditEntry[] = networkLogRef.current.slice(0, 120).map((entry) => ({
      strategy: 'network-request',
      source: entry.provenance || entry.initiatorType || 'wkwebview-runtime',
      url: entry.url,
      selected: false,
      mimeType: entry.mimeType,
      contentLength: entry.contentLength ?? entry.encodedBodySize ?? entry.transferSize,
      status: entry.status,
    }));
    const sourceAudit: SourceAuditEntry[] = [...networkAudit, ...htmlAudit];
    return {
      referer: pageUrl || undefined,
      ...pageData,
      mediaHints,
      sourceAudit,
    };
  }, []);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.event === 'BRIDGE_READY') {
        setBridgeOk(true);
        return;
      }

      if (data.event === 'SESSION_SNAPSHOT') {
        const requestId = String(data.requestId ?? '');
        const pending = pendingSnapshots.current.get(requestId);
        if (!pending) return;
        pendingSnapshots.current.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(buildSessionSnapshot({
          pageUrl: String(data.pageUrl ?? currentPageUrl.current),
          cookies: typeof data.cookies === 'string' ? data.cookies : '',
          pageHtml: typeof data.pageHtml === 'string' ? data.pageHtml : '',
        }));
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
        if (!url || isSegmentMediaUrl(url)) return;
        const pageUrl = (data.pageUrl as string) ?? currentPageUrl.current;
        const fromXhsPage = isXhsPageUrl(pageUrl);
        if (fromXhsPage && !isXhsMediaCandidate(url)) return;
        if (isNonContentMediaUrl(url, data.mimeType)) return;
        const mediaKind = data.mediaKind ?? guessKind(url, data.mimeType);
        if (mediaKind === 'image' && isLikelyThumbnailUrl(url)) return;
        const item: DetectedMedia = {
          id: genId(),
          url,
          pageUrl,
          userAgent: (data.userAgent as string) ?? '',
          timestamp: (data.timestamp as number) ?? Date.now(),
          mimeType: data.mimeType ?? undefined,
          mediaType: (data.mediaType as MediaType) ?? guessType(url),
          mediaKind,
          label: data.label ?? undefined,
          confidence: typeof data.confidence === 'number' ? data.confidence : 0.5,
          provenance: (data.provenance as Provenance) ?? 'perf-observer',
          sourcePageUrl: fromXhsPage ? pageUrl : undefined,
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
        const fromXhsPage = isXhsPageUrl(currentPageUrl.current);
        if (fromXhsPage && !isXhsMediaCandidate(url)) return;
        if (isNonContentMediaUrl(url)) return;
        const networkEntry: BrowserNetworkEntry = {
          url,
          pageUrl: typeof data.pageUrl === 'string' ? data.pageUrl : currentPageUrl.current,
          method: typeof data.method === 'string' ? data.method : undefined,
          status: typeof data.status === 'number' ? data.status : undefined,
          mimeType: typeof data.mimeType === 'string' ? data.mimeType : undefined,
          contentLength: typeof data.contentLength === 'number' ? data.contentLength : undefined,
          transferSize: typeof data.transferSize === 'number' ? data.transferSize : undefined,
          encodedBodySize: typeof data.encodedBodySize === 'number' ? data.encodedBodySize : undefined,
          provenance: typeof data.provenance === 'string' ? data.provenance as Provenance : undefined,
          initiatorType: typeof data.initiatorType === 'string' ? data.initiatorType : undefined,
          timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
        };
        setNetworkLog((prev) => {
          const idx = prev.findIndex((entry) => entry.url === url);
          if (idx === -1) return [networkEntry, ...prev].slice(0, 500);
          const existing = prev[idx];
          const merged: BrowserNetworkEntry = {
            ...existing,
            ...networkEntry,
            mimeType: networkEntry.mimeType ?? existing.mimeType,
            contentLength: networkEntry.contentLength ?? existing.contentLength,
            transferSize: networkEntry.transferSize ?? existing.transferSize,
            encodedBodySize: networkEntry.encodedBodySize ?? existing.encodedBodySize,
            status: networkEntry.status ?? existing.status,
            provenance: networkEntry.provenance ?? existing.provenance,
            initiatorType: networkEntry.initiatorType ?? existing.initiatorType,
          };
          const next = [...prev];
          next[idx] = merged;
          return next;
        });
        // Auto-promote manifests, direct media files, and known media CDN URLs
        const isImageCdn = /(?:cdninstagram\.com\/|scontent[-\w]*\.cdninstagram\.com\/|fbcdn\.net\/|threadscdn\.com\/|pinimg\.com\/(?:originals|736x|1200x|564x)\/|sinaimg\.cn\/|xhscdn\.com\/)/i.test(url);
        if ((isImageCdn || guessKind(url) === 'image') && isLikelyThumbnailUrl(url)) return;
        if (isRuntimeDownloadCandidate(url, currentPageUrl.current)) {
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
              sourcePageUrl: fromXhsPage ? currentPageUrl.current : undefined,
            }, ...prev];
          });
        }
        return;
      }

      if (data.event === 'YT_DETECTED') {
        // Telemetry from the injected script's YouTube extractor.
        // Useful for debugging; no state change needed.
        debugLog('[YT]', {
          videoId:      data.videoId,
          formats:      data.formatsCount,
          adaptive:     data.adaptiveCount,
          hasDirect:    data.hasDirect,
          hasDash:      data.hasDash,
          hasHls:       data.hasHls,
          isIOS:        data.isIOS,
          emitted:      data.emitted,
        });
        return;
      }

      if (data.event === 'MSE_STREAM' || data.event === 'MSE_ACTIVE') {
        setMseActive(true);
        return;
      }

      if (data.event === 'MSE_TRACK') {
        setMseActive(true);
        return;
      }

      if (data.event === 'MSE_MANIFEST') {
        // appendBuffer fired — MSE is actively playing.  Promote any recently-
        // captured manifest URLs (HLS/DASH) to detected so they appear in the UI
        // even if they were previously filtered or arrived at low confidence.
        setMseActive(true);
        const manifests = Array.isArray(data.manifests)
          ? (data.manifests as Array<{ url: string; mimeType: string }>)
          : [];
        if (manifests.length > 0) {
          const pageUrl = currentPageUrl.current;
          setDetected((prev) => {
            const existingUrls = new Set(prev.map((m) => m.url));
            const additions: DetectedMedia[] = [];
            for (const m of manifests) {
              const mUrl = String(m?.url ?? '').trim();
              if (!mUrl || existingUrls.has(mUrl) || isSegmentMediaUrl(mUrl)) continue;
              const mimeType = String(m?.mimeType ?? '');
              const mediaType: MediaType = /mpegurl|m3u8/i.test(mimeType) ? 'hls' : 'dash';
              additions.push({
                id: genId(),
                url: mUrl,
                pageUrl,
                userAgent: '',
                timestamp: Date.now(),
                mediaType,
                mediaKind: 'video',
                mimeType: mimeType || undefined,
                confidence: 0.92,
                provenance: 'manifest-parser',
              });
            }
            return additions.length > 0 ? [...additions, ...prev] : prev;
          });
        }
        return;
      }

      if (data.event === 'MEDIA_SESSION_META') {
        // Sites set navigator.mediaSession.metadata exactly when media starts
        // playing. Use the title to label the most recently detected video item
        // that still has a generic or missing label.
        const sessionTitle = String(data.title || '').trim();
        if (sessionTitle) {
          setDetected((prev) => {
            const idx = prev.findIndex(
              (m) => (m.mediaKind === 'video' || m.mediaKind === 'audio' || !m.mediaKind) &&
                     (!m.label || m.label === 'HLS' || m.label === 'DASH' || m.label === 'HLS master playlist' || m.label === 'HLS media playlist' || m.label === 'DASH MPD'),
            );
            if (idx === -1) return prev;
            const updated = [...prev];
            updated[idx] = { ...updated[idx], label: sessionTitle };
            return updated;
          });
        }
        return;
      }

      if (data.event === 'SCAN_DONE') {
        setScanDone(true);
        return;
      }
    } catch {}
  }, [buildSessionSnapshot]);

  const captureSessionSnapshot = useCallback((injectJavaScript?: (script: string) => void): Promise<BrowserSessionSnapshot> => {
    if (!injectJavaScript) return Promise.resolve(buildSessionSnapshot());
    const requestId = `snapshot_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingSnapshots.current.delete(requestId);
        resolve(buildSessionSnapshot());
      }, SESSION_SNAPSHOT_TIMEOUT_MS);
      pendingSnapshots.current.set(requestId, { resolve, timer });
      injectJavaScript(`
        (function () {
          try {
            var html = '';
            try { html = document.documentElement ? document.documentElement.outerHTML : ''; } catch (_) {}
            if (html && html.length > 1200000) html = html.slice(0, 1200000);
            window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
              event: 'SESSION_SNAPSHOT',
              requestId: ${JSON.stringify(requestId)},
              pageUrl: location.href,
              cookies: document.cookie || '',
              pageHtml: html,
              timestamp: Date.now()
            }));
          } catch (_) {}
          true;
        })();
      `);
    });
  }, [buildSessionSnapshot]);

  const addDetected = useCallback((url: string, pageUrl?: string) => {
    url = url.trim();
    if (!url) return false;
    if (!url.startsWith('http')) return false;
    if (isSegmentMediaUrl(url)) return false;
    if (isNonContentMediaUrl(url)) return false;
    let added = false;
    setDetected((prev) => {
      if (prev.some((m) => m.url === url)) return prev;
      added = true;
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
    return added;
  }, []);

  const addDetectedItems = useCallback((items: DetectedMedia[]) => {
    if (!items.length) return 0;
    let added = 0;
    setDetected((prev) => {
      const seen = new Set(prev.map((m) => m.url));
      const additions: DetectedMedia[] = [];
      for (const item of items) {
        if (!item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        additions.push({
          ...item,
          id: item.id || genId(),
          pageUrl: item.pageUrl || currentPageUrl.current,
          timestamp: item.timestamp || Date.now(),
        });
        added += 1;
      }
      return added > 0 ? [...additions, ...prev] : prev;
    });
    return added;
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
    onPageChange, onMessage, addDetected, addDetectedItems, dismiss, clear, captureSessionSnapshot,
  };
}

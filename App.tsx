import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  DeviceEventEmitter,
  Image,
  Modal,
  NativeModules,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import WebView from 'react-native-webview';
import Icon from './src/components/Icon';
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import * as Linking from 'expo-linking';
import * as Clipboard from 'expo-clipboard';

import BrowserView from './src/components/BrowserView';
import Toast, { ToastMessage } from './src/components/Toast';
import SettingsSheet from './src/components/SettingsSheet';
import { translate, TranslationKey } from './src/constants/translations';

import { useMediaDetection } from './src/hooks/useMediaDetection';
import { useDownloadManager } from './src/hooks/useDownloadManager';
import { useBookmarks } from './src/hooks/useBookmarks';
import { useSettings } from './src/hooks/useSettings';
import { DetectedMedia, DownloadTask } from './src/types';
import { extractionManager } from './src/lib/extractionManager';
import { ServerExtractOptions, setRemoveWatermark, setPreferredQuality } from './src/lib/serverExtractor';
import { runAutomatedStrategyTest } from './src/lib/automatedTester';
import { debugLog } from './src/lib/releaseLogger';
import { signalWeiboPrewarmComplete, signalWeiboFetchComplete } from './src/lib/weiboPrewarm';
import { extractSessionCookies } from './src/lib/cookieManager';
import {
  BOTTOM_PAD,
  IS_ANDROID,
  IS_IOS,
  R,
  RIPPLE,
  RIPPLE_BL,
  S,
  subtleShadow,
  TOP_PAD,
  useTheme,
} from './src/theme/appTheme';
import {
  formatBytes,
  getFormatResolution,
  getInitial,
  getMediaFormat,
  getMediaKind,
  getMediaResolution,
  getMimeFromPath,
  getPageTitle,
  getQuality,
  getSourceName,
  guessMediaType,
  isDirectMediaUrl,
  isRuntimeDownloadCandidate,
  smartDedup,
} from './src/lib/mediaHelpers';
import {
  decideUniversalResultHandling,
  simplifyUniversalPickerCandidates,
} from './src/lib/universalResultPicker';
import { inspectUniversalManifestCandidates } from './src/lib/universalManifestInspector';
import { verifyUniversalDirectCandidates } from './src/lib/universalUrlVerifier';
import { extractFirstUrl, extractSharedUrlFromDeepLink } from './src/lib/shareUrl';

const { ShareIntentModule } = NativeModules as {
  ShareIntentModule?: {
    getPendingShareUrl: () => Promise<string | null>;
  };
};

// ── Layout constants ──────────────────────────────────────────
// ── Ripple ────────────────────────────────────────────────────
// ── Spacing / radius ──────────────────────────────────────────
// ── Color tokens ──────────────────────────────────────────────
// ── Helpers ───────────────────────────────────────────────────

// ── URL classification ────────────────────────────────────────

// ── Dedup ─────────────────────────────────────────────────────

// ── Shadow ────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
type Tab = 'home' | 'browser' | 'library' | 'bookmarks' | 'settings';

function getBookmarkColor(domain: string): string {
  const d = domain.toLowerCase();
  if (d.includes('youtube')) return '#FF0000';
  if (d.includes('tiktok')) return '#111111';
  if (d.includes('instagram')) return '#E1306C';
  if (d.includes('twitter') || d.includes('x.com')) return '#1DA1F2';
  if (d.includes('bilibili')) return '#00AEEC';
  return '#5B5BD6';
}

function getBookmarkInitials(domain: string): string {
  const d = domain.toLowerCase();
  if (d.includes('youtube')) return 'YT';
  if (d.includes('tiktok')) return 'TT';
  if (d.includes('instagram')) return 'IG';
  if (d.includes('twitter') || d.includes('x.com')) return 'X';
  if (d.includes('bilibili')) return 'B';
  return domain.charAt(0).toUpperCase();
}

function mediaPageUrl(item: DetectedMedia): string {
  return item.sourcePageUrl || item.pageUrl || item.url;
}

function mediaSourceName(item: DetectedMedia): string {
  return getSourceName(item.url, item.mediaKind, mediaPageUrl(item));
}

function isThreadsPageUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'threads.net' || host === 'www.threads.net'
      || host === 'threads.com' || host === 'www.threads.com';
  } catch {
    return /threads\.(?:net|com)\//i.test(url);
  }
}

function shouldPickThreadsCandidates(pageUrl: string, items: DetectedMedia[]): boolean {
  return isThreadsPageUrl(pageUrl) && items.length > 1;
}

function extractionDedupeKey(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const segments = parsed.pathname.split('/').filter(Boolean);
      const videoIndex = segments.findIndex((segment) => /^\d+$/.test(segment));
      if (videoIndex >= 0) {
        const privateHash =
          parsed.searchParams.get('h') ||
          (host === 'vimeo.com' && videoIndex === 0 && /^[a-z0-9]+$/i.test(segments[1] ?? '')
            ? segments[1]
            : '');
        return `vimeo:${segments[videoIndex]}:${privateHash}`;
      }
    }
    parsed.hostname = host;
    parsed.hash = '';
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return rawUrl.trim().replace(/\/+$/, '');
  }
}

function waitForUiCommit(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 50);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function getPlatformColor(item: DetectedMedia): string {
  const lower = `${item.url} ${mediaPageUrl(item)}`.toLowerCase();
  if (lower.includes('youtube') || lower.includes('youtu.be')) {
    return '#A855F7'; // YouTube purple/violet
  }
  if (lower.includes('tiktok')) {
    return '#06B6D4'; // TikTok cyan/blue
  }
  if (lower.includes('threads.')) {
    return '#111111';
  }
  if (lower.includes('instagram')) {
    return '#E1306C'; // Instagram pink/red
  }
  return '#5B5BD6'; // Default color
}

function formatOptionLabel(format: NonNullable<DetectedMedia['availableFormats']>[number]): string {
  const resolution = getFormatResolution(format);
  const parts = [
    format.label && format.label !== resolution ? format.label : undefined,
    resolution,
    format.ext?.toUpperCase(),
    format.vcodec && format.vcodec !== 'none' ? format.vcodec : undefined,
    format.acodec && format.acodec !== 'none' ? format.acodec : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('  ') : format.id;
}

function selectableFormatOptions(item: DetectedMedia): NonNullable<DetectedMedia['availableFormats']> {
  const formats = item.availableFormats ?? [];
  if (item.extractor === 'universal-probe') {
    return formats.filter((format) => format.selectable !== false && (item.mediaType === 'dash' || !!format.url));
  }
  return formats;
}

function compactMediaDetails(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part))
    .filter((part, index, all) => all.indexOf(part) === index)
    .join('  |  ');
}

function candidateSourceDetails(item: DetectedMedia): string | null {
  const audit = item.sourceAudit?.find((entry) => entry.selected) ?? item.sourceAudit?.[0];
  const source = audit?.source || item.provenance || item.extractor;
  const sourceLabel = source
    ? String(source).replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
    : null;
  const status = audit?.status ? `HTTP ${audit.status}` : null;
  const size = audit?.contentLength ? formatBytes(audit.contentLength) : null;
  const confidence = typeof item.confidence === 'number' ? `${Math.round(item.confidence * 100)}%` : null;
  return compactMediaDetails(sourceLabel, status, size, confidence);
}

function mediaKindLabel(item: DetectedMedia): string {
  const kind = getMediaKind(item);
  if (kind === 'image') return 'Image';
  if (kind === 'audio') return 'Audio';
  if (kind === 'subtitle') return 'Subtitle';
  return 'Video';
}

function candidateDisplayTitle(item: DetectedMedia, items: DetectedMedia[]): string {
  const source = mediaSourceName(item);
  const kind = getMediaKind(item);
  const kindLabel = mediaKindLabel(item);
  const sameSourceKind = items.filter((candidate) =>
    getMediaKind(candidate) === kind && mediaSourceName(candidate) === source
  );
  const index = sameSourceKind.findIndex((candidate) => candidate.id === item.id);
  const suffix = sameSourceKind.length > 1 && index >= 0 ? ` ${index + 1}` : '';
  const prefix = source.toLowerCase() === kindLabel.toLowerCase() ? '' : `${source} `;
  return `${prefix}${kindLabel}${suffix}`;
}

export default function App() {
  const {
    theme,
    fontSize,
    fontScale,
    language,
    resolvedLanguage,
    removeWatermark,
    preferredQuality,
    setTheme,
    setFontSize,
    setLanguage,
    setRemoveWatermark: saveRemoveWatermark,
    setPreferredQuality: savePreferredQuality,
  } = useSettings();

  // Keep the serverExtractor module-level flags in sync with settings.
  useEffect(() => { setRemoveWatermark(removeWatermark); }, [removeWatermark]);
  useEffect(() => { setPreferredQuality(preferredQuality); }, [preferredQuality]);
  const t = useTheme(theme === 'system' ? undefined : theme === 'dark');
  const isDark = t.dark;
  const fs = (base: number) => base * fontScale;
  const webviewRef = useRef<WebView>(null);
  // Note IDs we've already auto-extracted, so a single XHS page load only kicks
  // off extraction once (onLoadEnd fires repeatedly across redirects/subframes).
  const autoExtractedRef = useRef<string | null>(null);

  const resolvedLangRef = useRef(resolvedLanguage);
  resolvedLangRef.current = resolvedLanguage;

  const editLabel = resolvedLanguage === 'ar' ? 'تعديل' : (resolvedLanguage === 'zh' ? '编辑' : (resolvedLanguage === 'ja' ? '編集' : (resolvedLanguage === 'ko' ? '편집' : (resolvedLanguage === 'es' ? 'Editar' : (resolvedLanguage === 'fr' ? 'Modifier' : (resolvedLanguage === 'de' ? 'Bearbeiten' : 'Edit'))))));

  // ── Weibo visitor session pre-warm ────────────────────────
  const [weiboPrewarmActive, setWeiboPrewarmActive] = useState(false);
  const weiboWebViewRef = useRef<WebView | null>(null);
  const weiboAutoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const startSub = DeviceEventEmitter.addListener('weibo:prewarm:start', () => setWeiboPrewarmActive(true));
    const cancelSub = DeviceEventEmitter.addListener('weibo:prewarm:cancel', () => {
      if (weiboAutoDismissRef.current) { clearTimeout(weiboAutoDismissRef.current); weiboAutoDismissRef.current = null; }
      setWeiboPrewarmActive(false);
    });
    // After prewarm, platformExtractors calls fetchWeiboStatuses() which emits this event.
    // We inject a fetch() into the still-live WKWebView (which has the visitor cookie)
    // and relay the JSON response back via postMessage → signalWeiboFetchComplete.
    const fetchSub = DeviceEventEmitter.addListener('weibo:fetch:start', (apiUrl: string) => {
      const ref = weiboWebViewRef.current;
      if (!ref) { signalWeiboFetchComplete(null); return; }
      const safeUrl = JSON.stringify(apiUrl);
      ref.injectJavaScript(
        `(function(){fetch(${safeUrl},{credentials:'include',headers:{'Accept':'application/json'}})` +
        `.then(function(r){return r.json();})` +
        `.then(function(d){window.ReactNativeWebView.postMessage('weibo_statuses:'+JSON.stringify(d));})` +
        `.catch(function(){window.ReactNativeWebView.postMessage('weibo_statuses:null');});})();true;`
      );
    });
    return () => { startSub.remove(); cancelSub.remove(); fetchSub.remove(); };
  }, []);

  // ── Navigation ────────────────────────────────────────────
  const [tab, setTab]               = useState<Tab>('home');
  const [pasteUrl, setPasteUrl]     = useState('');
  const [browserInput, setBrowserInput] = useState('');
  const [loadedUrl, setLoadedUrl]   = useState('about:blank');

  // ── UI ────────────────────────────────────────────────────
  const [videosOpen, setVideosOpen]     = useState(false);
  const [universalPickerOpen, setUniversalPickerOpen] = useState(false);
  const [previewItem, setPreviewItem]   = useState<DetectedMedia | null>(null);
  const [selectedFormatId, setSelectedFormatId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast]               = useState<ToastMessage | null>(null);
  const [extracting, setExtracting]     = useState(false);
  const [fileSizes, setFileSizes]       = useState<Record<string, string>>({});
  const [libSelectMode, setLibSelectMode] = useState(false);
  const [libSelected, setLibSelected]     = useState<Set<string>>(new Set());
  const [libFilter, setLibFilter]         = useState<'all' | 'videos' | 'audio' | 'failed'>('all');
  const [bmEditMode, setBmEditMode]       = useState(false);

  // ── Core hooks ────────────────────────────────────────────
  const {
    detected,
    networkLog,
    mseActive,
    onPageChange,
    onMessage,
    addDetected,
    addDetectedItems,
    replaceDetectedItems,
    captureSessionSnapshot,
  } = useMediaDetection();
  const { bookmarks, toggle: toggleBM, remove: removeBM, isSaved } = useBookmarks();

  const showToast = useCallback((msg: string, type: ToastMessage['type'] = 'info') => {
    setToast({ id: String(Date.now()), text: msg, type });
  }, []);

  const closeVideosSheet = useCallback(() => {
    setVideosOpen(false);
    setPreviewItem(null);
    setUniversalPickerOpen(false);
  }, []);

  const homepageSet = useRef(false);
  useEffect(() => {
    setSelectedFormatId(null);
  }, [previewItem?.id]);

  useEffect(() => {
    if (homepageSet.current) return;
    const home = bookmarks[0]?.url ?? 'https://www.google.com';
    setLoadedUrl(home); setBrowserInput(home);
    homepageSet.current = true;
  }, [bookmarks]);

  // ── Download manager ──────────────────────────────────────
  const { active, history, enqueue, retry, cancel, remove } = useDownloadManager({
    onComplete: useCallback(() => showToast(translate('downloadComplete', resolvedLangRef.current), 'success'), [showToast]),
    onError:    useCallback((task: DownloadTask) => {
      const lang = resolvedLangRef.current;
      if (task.errorCode === 'AUTH_REQUIRED') showToast(translate('authRequired', lang), 'error');
      else if (task.errorCode === 'GEO_BLOCKED') showToast(translate('geoBlocked', lang), 'error');
      else if (task.errorCode === 'RATE_LIMITED') showToast(translate('rateLimited', lang), 'error');
      else showToast(translate('failedError', lang, { error: task.error ?? 'unknown error' }), 'error');
    }, [showToast]),
  });

  const [extractionQueue, setExtractionQueue] = useState<string[]>([]);
  const [extractionRunnerTick, setExtractionRunnerTick] = useState(0);
  const handledSharedUrlsRef = useRef<Map<string, number>>(new Map());
  const queuedExtractionUrlsRef = useRef(new Set<string>());
  const extractionRunnerActiveRef = useRef(false);

  const runExtractionAndDownload = useCallback(async (url: string) => {
    let targetUrl = url.trim();
    if (!targetUrl) return;
    if (!targetUrl.startsWith('http')) targetUrl = `https://${targetUrl}`;

    // A pasted/shared URL starts a new detection session. Without this reset,
    // iOS could briefly reopen the picker with media left over from the
    // previously browsed page while the new extraction was still running.
    closeVideosSheet();
    onPageChange(targetUrl);

    if (isDirectMediaUrl(targetUrl)) {
      const item: DetectedMedia = {
        id: `home_${Date.now()}`, url: targetUrl, pageUrl: targetUrl, userAgent: '',
        timestamp: Date.now(),
        mediaType: guessMediaType(targetUrl),
        mediaKind: getMediaKind({ url: targetUrl }),
        confidence: 0.75, provenance: 'manual',
      };
      setPasteUrl('');
      setTab('library');
      await waitForUiCommit();
      const started = await enqueue(item);
      if (started) showToast(translate('downloadStarted', resolvedLangRef.current), 'success');
      return;
    }

    setExtracting(true);
    try {
      const result = await extractionManager.extract(targetUrl);
      const inspected = await inspectUniversalManifestCandidates(result.strategy, result.media ?? []);
      const items = await verifyUniversalDirectCandidates(result.strategy, inspected);
      const decision = decideUniversalResultHandling(result.strategy, items, targetUrl);
      if (decision.action === 'enqueue') {
        const enqueueItems = shouldPickThreadsCandidates(targetUrl, decision.items)
          ? simplifyUniversalPickerCandidates(decision.items, targetUrl)
          : decision.items;
        if (shouldPickThreadsCandidates(targetUrl, enqueueItems)) {
          replaceDetectedItems(enqueueItems, targetUrl);
          setPasteUrl('');
          setLoadedUrl(targetUrl);
          setBrowserInput(targetUrl);
          setUniversalPickerOpen(true);
          setVideosOpen(true);
          showToast(translate('mediaItemsFound', resolvedLangRef.current, { count: enqueueItems.length }), 'info');
          return;
        }
        setPasteUrl('');
        setExtracting(false);
        setTab('library');
        // Let the Home → Library transition commit before the downloader starts
        // issuing network callbacks and native file writes.
        await waitForUiCommit();
        let started = 0;
        for (const item of enqueueItems) {
          if (await enqueue(item)) started += 1;
        }
        if (started > 0) {
          showToast(
            started === 1
              ? translate('startedDownload', resolvedLangRef.current)
              : translate('startedDownloads', resolvedLangRef.current, { count: started }),
            'success'
          );
        }
        return;
      }
      if (decision.action === 'pick') {
        const pickerItems = simplifyUniversalPickerCandidates(decision.items, targetUrl);
        replaceDetectedItems(pickerItems, targetUrl);
        setPasteUrl('');
        setLoadedUrl(targetUrl);
        setBrowserInput(targetUrl);
        setUniversalPickerOpen(true);
        setVideosOpen(true);
        showToast(
          pickerItems.length === 1
            ? translate('mediaItemFound', resolvedLangRef.current)
            : translate('mediaItemsFound', resolvedLangRef.current, { count: pickerItems.length }),
          'info'
        );
        return;
      }
      const lang = resolvedLangRef.current;
      if (result.errorCode === 'AUTH_REQUIRED') showToast(translate('authRequired', lang), 'error');
      else if (result.errorCode === 'GEO_BLOCKED') showToast(translate('geoBlocked', lang), 'error');
      else if (result.errorCode === 'RATE_LIMITED') showToast(translate('rateLimited', lang), 'error');
      else showToast(translate('openingInBrowserScan', lang), 'info');
    } catch {
      showToast(translate('openingInBrowser', resolvedLangRef.current), 'info');
    } finally {
      setExtracting(false);
    }
    setLoadedUrl(targetUrl); setBrowserInput(targetUrl); setTab('browser');
  }, [
    closeVideosSheet,
    enqueue,
    onPageChange,
    replaceDetectedItems,
    showToast,
    setPasteUrl,
    setTab,
    setLoadedUrl,
    setBrowserInput,
  ]);

  useEffect(() => {
    if (extracting || extractionRunnerActiveRef.current || extractionQueue.length === 0) return;
    const nextUrl = extractionQueue[0];
    extractionRunnerActiveRef.current = true;
    setExtractionQueue((prev) => prev.slice(1));
    void runExtractionAndDownload(nextUrl).finally(() => {
      queuedExtractionUrlsRef.current.delete(extractionDedupeKey(nextUrl));
      extractionRunnerActiveRef.current = false;
      // The queue owns the Home extraction lifecycle. Clear the visible busy
      // state here as a final guard against stale batched updates from an early
      // return after a candidate has already been enqueued.
      setExtracting(false);
      setExtractionRunnerTick((tick) => tick + 1);
    });
  }, [extracting, extractionQueue, extractionRunnerTick, runExtractionAndDownload]);

  // ── Start download and extraction ───────────────────────
  const startDownloadAndExtraction = useCallback((url: string) => {
    const targetUrl = url.trim();
    if (!targetUrl) return;
    const dedupeKey = extractionDedupeKey(targetUrl);
    if (queuedExtractionUrlsRef.current.has(dedupeKey)) return;
    queuedExtractionUrlsRef.current.add(dedupeKey);
    setExtractionQueue((prev) => [...prev, targetUrl]);
  }, []);

  const handleSharedMediaUrl = useCallback((url: string) => {
    const mediaUrl = extractFirstUrl(url).trim();
    if (!/^https?:\/\//i.test(mediaUrl)) {
      showToast(translate('failedError', resolvedLangRef.current, { error: 'No link found in shared content' }), 'error');
      return;
    }
    const now = Date.now();
    const dedupeKey = extractionDedupeKey(mediaUrl);
    const lastHandledAt = handledSharedUrlsRef.current.get(dedupeKey);
    // iOS can deliver the same share once through the deep link and once
    // through App Group storage, sometimes again when the app becomes active
    // after extraction. Keep that transport-level duplicate out of the queue;
    // the Home Download button remains available for an immediate manual retry.
    if (lastHandledAt && now - lastHandledAt < 60_000) return;
    for (const [handledUrl, handledAt] of handledSharedUrlsRef.current) {
      if (now - handledAt >= 60_000) handledSharedUrlsRef.current.delete(handledUrl);
    }
    handledSharedUrlsRef.current.set(dedupeKey, now);
    setPasteUrl(mediaUrl);
    setTab('home');
    showToast(translate('linkReceived', resolvedLangRef.current), 'success');
    startDownloadAndExtraction(mediaUrl);
  }, [showToast, startDownloadAndExtraction, setPasteUrl, setTab]);

  const handleIncomingUrl = useCallback((raw: string) => {
    try {
      const parsed = Linking.parse(raw);
      debugLog('Incoming URL:', raw, parsed);
      if (parsed.path === 'test_strategies' || parsed.path === '/test_strategies' || parsed.hostname === 'test_strategies') {
        const mediaUrl = parsed.queryParams?.url ? String(parsed.queryParams.url) : null;
        const reportUrl = parsed.queryParams?.reportUrl ? String(parsed.queryParams.reportUrl) : null;
        if (mediaUrl && reportUrl) {
          runAutomatedStrategyTest(mediaUrl, reportUrl);
        }
        return;
      }
      if (parsed.path === 'share' || parsed.hostname === 'share') {
        const mediaUrl = extractSharedUrlFromDeepLink(raw, parsed.queryParams);
        if (mediaUrl) {
          handleSharedMediaUrl(mediaUrl);
        } else {
          showToast(translate('failedError', resolvedLangRef.current, { error: 'No link found in shared content' }), 'error');
        }
      }
    } catch {}
  }, [handleSharedMediaUrl, showToast]);

  useEffect(() => {
    let cancelled = false;
    const consumePendingShareUrl = async () => {
      if (!IS_IOS || !ShareIntentModule?.getPendingShareUrl) return;
      try {
        const pending = await ShareIntentModule.getPendingShareUrl();
        if (!cancelled && pending) handleSharedMediaUrl(pending);
      } catch {}
    };

    Linking.getInitialURL()
      .then((url) => { if (url) handleIncomingUrl(url); })
      .finally(() => { consumePendingShareUrl(); });
    const sub = Linking.addEventListener('url', ({ url }) => handleIncomingUrl(url));
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') consumePendingShareUrl();
    });
    return () => {
      cancelled = true;
      sub.remove();
      appStateSub.remove();
    };
  }, [handleIncomingUrl, handleSharedMediaUrl]);

  // ── Detected videos ───────────────────────────────────────
  const allVideos = useMemo<DetectedMedia[]>(() => {
    const seen = new Set(detected.map((m) => m.url));
    const fromNet: DetectedMedia[] = networkLog
      .filter((entry) => isRuntimeDownloadCandidate(entry.url, loadedUrl) && !seen.has(entry.url))
      .map((entry) => ({
        id: `net_${entry.url}`,
        url: entry.url,
        pageUrl: entry.pageUrl || loadedUrl,
        userAgent: '',
        timestamp: Date.now(),
        mediaType: guessMediaType(entry.url),
        mediaKind: getMediaKind({ url: entry.url, mimeType: entry.mimeType }),
        mimeType: entry.mimeType,
        confidence: entry.provenance === 'fetch-hook' || entry.provenance === 'xhr-hook' ? 0.62 : 0.5,
        provenance: entry.provenance,
        label: entry.mimeType,
        sourcePageUrl: entry.pageUrl,
        sourceAudit: [{
          strategy: 'network-request',
          source: entry.provenance || entry.initiatorType || 'wkwebview-runtime',
          url: entry.url,
          selected: false,
          mimeType: entry.mimeType,
          contentLength: entry.contentLength ?? entry.encodedBodySize ?? entry.transferSize,
          status: entry.status,
        }],
      }));
    return smartDedup([...detected, ...fromNet], loadedUrl);
  }, [detected, networkLog, loadedUrl]);

  const pickerVideos = useMemo<DetectedMedia[]>(() => {
    return universalPickerOpen
      ? simplifyUniversalPickerCandidates(allVideos, loadedUrl)
      : allVideos;
  }, [allVideos, loadedUrl, universalPickerOpen]);

  const allTasks    = useMemo(() => [...active, ...history], [active, history]);
  const doneTasks   = useMemo(() => history.filter((t) => t.status === 'completed'), [history]);
  const failedTasks = useMemo(() => history.filter((t) => t.status !== 'completed'), [history]);

  const filteredActive = useMemo(() => {
    if (libFilter === 'failed') return [];
    if (libFilter === 'videos') return active.filter(t => getMediaKind(t.media) === 'video');
    if (libFilter === 'audio') return active.filter(t => getMediaKind(t.media) === 'audio');
    return active;
  }, [active, libFilter]);

  const filteredHistory = useMemo(() => {
    if (libFilter === 'all') return history;
    if (libFilter === 'videos') return history.filter(t => getMediaKind(t.media) === 'video' && t.status === 'completed');
    if (libFilter === 'audio') return history.filter(t => getMediaKind(t.media) === 'audio' && t.status === 'completed');
    if (libFilter === 'failed') return history.filter(t => t.status === 'failed');
    return history;
  }, [history, libFilter]);

  useEffect(() => {
    history.forEach(async (task) => {
      if (task.status !== 'completed' || !task.localPlaylistPath || fileSizes[task.id]) return;
      try {
        const info = await FileSystem.getInfoAsync(task.localPlaylistPath);
        const fileSize: number = (info as any).size ?? 0;

        if (info.exists && fileSize > 50 * 1024) {
          // Normal: large file (mp4 / ts / webm)
          setFileSizes((p) => ({ ...p, [task.id]: formatBytes(fileSize) }));
        } else if (task.localPlaylistPath.endsWith('.m3u8')) {
          // Encrypted HLS: the playlist itself is tiny; sum the segment files
          const dir = task.localPlaylistPath.slice(
            0, task.localPlaylistPath.lastIndexOf('/') + 1,
          );
          try {
            const files = await FileSystem.readDirectoryAsync(dir);
            let total = 0;
            for (const f of files) {
              if (/\.(ts|m4s|mp4)$/i.test(f)) {
                const fi = await FileSystem.getInfoAsync(dir + f);
                total += (fi as any).size ?? 0;
              }
            }
            if (total > 0) setFileSizes((p) => ({ ...p, [task.id]: formatBytes(total) }));
          } catch {}
        } else if (info.exists && fileSize > 0) {
          setFileSizes((p) => ({ ...p, [task.id]: formatBytes(fileSize) }));
        }
      } catch {}
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.length]);

  useEffect(() => {
    if (tab !== 'library') { setLibSelectMode(false); setLibSelected(new Set()); }
  }, [tab]);

  // ── Browser navigation ────────────────────────────────────
  const navigateBrowser = useCallback(() => {
    let url = browserInput.trim();
    if (!url) return;
    if (!url.startsWith('http')) url = `https://${url}`;
    setBrowserInput(url);
    if (url === loadedUrl) webviewRef.current?.reload();
    else setLoadedUrl(url);
  }, [browserInput, loadedUrl]);

  const scanBrowserPage = useCallback(() => {
    webviewRef.current?.injectJavaScript(`
      try {
        if (window.__fcdownloader_scan) window.__fcdownloader_scan();
      } catch (_) {}
      true;
    `);
    showToast(translate('scanningPage', resolvedLangRef.current), 'info');
  }, [showToast]);

  const browserSessionFor = useCallback(async (pageUrl: string): Promise<ServerExtractOptions | undefined> => {
    if (tab !== 'browser') return undefined;
    const target = pageUrl.trim();
    if (!target || target === 'about:blank') return undefined;
    const snapshot = await captureSessionSnapshot((script) => webviewRef.current?.injectJavaScript(script));
    return {
      referer: snapshot.referer || snapshot.pageUrl || loadedUrl || target,
      cookies: snapshot.cookies,
      pageHtml: snapshot.pageHtml,
      mediaHints: snapshot.mediaHints,
      sourceAudit: snapshot.sourceAudit,
    };
  }, [captureSessionSnapshot, loadedUrl, tab]);

  const extractBrowserPage = useCallback(async (pageUrl = loadedUrl) => {
    const url = pageUrl.trim();
    if (!url || url === 'about:blank' || extracting) return;
    setExtracting(true);
    try {
      const session = await browserSessionFor(url);
      const result = await extractionManager.extract(url, session);
      const inspected = await inspectUniversalManifestCandidates(result.strategy, result.media ?? []);
      const items = await verifyUniversalDirectCandidates(result.strategy, inspected);
      const decision = decideUniversalResultHandling(result.strategy, items, url);
      if (decision.action === 'enqueue') {
        const enqueueItems = shouldPickThreadsCandidates(url, decision.items)
          ? simplifyUniversalPickerCandidates(decision.items, url)
          : decision.items;
        if (shouldPickThreadsCandidates(url, enqueueItems)) {
          addDetectedItems(enqueueItems);
          setUniversalPickerOpen(true);
          setVideosOpen(true);
          showToast(translate('mediaItemsFound', resolvedLangRef.current, { count: enqueueItems.length }), 'info');
          return;
        }
        let started = 0;
        for (const item of enqueueItems) {
          if (await enqueue(item)) started += 1;
        }
        if (started > 0) {
          showToast(
            started === 1
              ? translate('startedDownload', resolvedLangRef.current)
              : translate('startedDownloads', resolvedLangRef.current, { count: started }),
            'success'
          );
        }
        setTab('library');
        return;
      }
      if (decision.action === 'pick') {
        const pickerItems = simplifyUniversalPickerCandidates(decision.items, url);
        addDetectedItems(pickerItems);
        setUniversalPickerOpen(true);
        setVideosOpen(true);
        showToast(
          pickerItems.length === 1
            ? translate('mediaItemFound', resolvedLangRef.current)
            : translate('mediaItemsFound', resolvedLangRef.current, { count: pickerItems.length }),
          'info'
        );
        return;
      }
      showToast(translate('scanningPage', resolvedLangRef.current), 'info');
      scanBrowserPage();
    } finally {
      setExtracting(false);
    }
  }, [addDetectedItems, browserSessionFor, enqueue, extracting, loadedUrl, scanBrowserPage, showToast]);

  // XHS gates its note pages and there's no inline player to detect, so a manual
  // Scan rarely surfaces anything. When an XHS note page finishes loading in the
  // in-app browser, auto-run extraction (server first, then on-device) once per
  // note — the user no longer has to tap Scan. Other sites keep the manual flow.
  const handleBrowserLoadEnd = useCallback((url: string) => {
    const noteId = url.match(/\/(?:explore|discovery\/item|item)\/([a-f0-9]{24})/i)?.[1];
    if (!noteId || autoExtractedRef.current === noteId) return;
    autoExtractedRef.current = noteId;
    extractBrowserPage(url);
  }, [extractBrowserPage]);

  // ── Home: paste → download ────────────────────────────────
  const handleHomePaste = useCallback(async () => {
    const text = await Clipboard.getStringAsync();
    if (!text.trim()) return;
    setPasteUrl(extractFirstUrl(text));
  }, []);

  const handleHomeDownload = useCallback(() => {
    startDownloadAndExtraction(pasteUrl);
  }, [pasteUrl, startDownloadAndExtraction]);

  // ── Browser: download detected video ─────────────────────
  const handleDetectedDownload = useCallback(async (item: DetectedMedia) => {
    closeVideosSheet();
    const formats = selectableFormatOptions(item);
    const selected = selectedFormatId && formats.some((f) => f.id === selectedFormatId)
      ? formats.find((f) => f.id === selectedFormatId)
      : null;
    const started = await enqueue(selected
      ? {
          ...item,
          url: item.mediaType === 'dash' ? item.url : selected.url ?? item.url,
          formatId: selected.id,
          label: selected.label ?? item.label,
          mimeType: selected.ext ? `${item.mediaKind === 'audio' ? 'audio' : 'video'}/${selected.ext}` : item.mimeType,
          forceServerDownload: item.mediaType === 'dash' || selected.url ? item.forceServerDownload : true,
        }
      : item);
    setSelectedFormatId(null);
    if (started) showToast(translate('downloadStarted', resolvedLangRef.current), 'success');
    setTab('library');
  }, [closeVideosSheet, enqueue, selectedFormatId, showToast]);

  const handleDetectedAudioDownload = useCallback(async (item: DetectedMedia) => {
    closeVideosSheet();
    const started = await enqueue({
      ...item,
      id: `${item.id}_audio_${Date.now()}`,
      url: item.sourcePageUrl || item.pageUrl || item.url,
      mediaKind: 'audio',
      mediaType: 'direct',
      mimeType: 'audio/mp4',
      label: 'Audio only',
      audioOnly: true,
      forceServerDownload: true,
      sourcePageUrl: item.sourcePageUrl || item.pageUrl || item.url,
      formatId: undefined,
    });
    setSelectedFormatId(null);
    if (started) showToast(translate('audioDownloadStarted', resolvedLangRef.current), 'success');
    setTab('library');
  }, [closeVideosSheet, enqueue, showToast]);

  const handleDownloadAllDetected = useCallback(async () => {
    if (!allVideos.length) return;
    closeVideosSheet();
    let started = 0;
    for (const item of allVideos) {
      if (await enqueue(item)) started += 1;
    }
    if (started > 0) {
      showToast(
        started === 1
          ? translate('startedDownload', resolvedLangRef.current)
          : translate('startedDownloads', resolvedLangRef.current, { count: started }),
        'success'
      );
    }
    setTab('library');
  }, [allVideos, closeVideosSheet, enqueue, showToast]);

  const handleDownloadAllAudio = useCallback(async () => {
    const audioItems = allVideos.filter((item) => getMediaKind(item) !== 'image');
    if (!audioItems.length) return;
    closeVideosSheet();
    let started = 0;
    for (const item of audioItems) {
      if (await enqueue({
        ...item,
        id: `${item.id}_audio_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        url: item.sourcePageUrl || item.pageUrl || item.url,
        mediaKind: 'audio',
        mediaType: 'direct',
        mimeType: 'audio/mp4',
        label: 'Audio only',
        audioOnly: true,
        forceServerDownload: true,
        sourcePageUrl: item.sourcePageUrl || item.pageUrl || item.url,
        formatId: undefined,
      })) started += 1;
    }
    if (started > 0) {
      showToast(
        started === 1
          ? translate('startedAudioDownload', resolvedLangRef.current)
          : translate('startedAudioDownloads', resolvedLangRef.current, { count: started }),
        'success'
      );
    }
    setTab('library');
  }, [allVideos, closeVideosSheet, enqueue, showToast]);

  // ── Export / Gallery ──────────────────────────────────────
  const handleExport = useCallback(async (task: DownloadTask) => {
    if (!task.localPlaylistPath) return;
    try {
      if (!(await Sharing.isAvailableAsync())) { showToast(translate('sharingNotAvailable', resolvedLangRef.current), 'error'); return; }
      const path = task.localPlaylistPath;
      const mime = getMimeFromPath(path);
      await Sharing.shareAsync(path, { mimeType: mime, dialogTitle: translate('exportMedia', resolvedLangRef.current) });
    } catch (e) { showToast(translate('exportFailed', resolvedLangRef.current, { error: (e as Error).message }), 'error'); }
  }, [showToast]);

  const handleGallery = useCallback(async (task: DownloadTask) => {
    if (!task.localPlaylistPath) return;
    const { status } = await MediaLibrary.requestPermissionsAsync(true, ['photo', 'video']);
    if (status !== 'granted') { showToast(translate('galleryPermissionDenied', resolvedLangRef.current), 'error'); return; }
    try {
      await MediaLibrary.saveToLibraryAsync(task.localPlaylistPath);
      showToast(translate('savedToGallery', resolvedLangRef.current), 'success');
    } catch (e) { showToast(translate('gallerySaveFailed', resolvedLangRef.current, { error: (e as Error).message }), 'error'); }
  }, [showToast]);

  const handleRetry = useCallback((task: DownloadTask) => {
    retry(task.id, task.strategy);
    showToast(translate('retrying', resolvedLangRef.current), 'info');
  }, [retry, showToast]);

  const toggleLibSelect = useCallback((id: string) => {
    setLibSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const exitLibSelectMode = useCallback(() => {
    setLibSelectMode(false);
    setLibSelected(new Set());
  }, []);

  const selectAllLib = useCallback(() => {
    if (libSelected.size === history.length) {
      setLibSelected(new Set());
    } else {
      setLibSelected(new Set(history.map((t) => t.id)));
    }
  }, [libSelected.size, history]);

  const deleteLibSelected = useCallback(() => {
    const ids = Array.from(libSelected);
    if (ids.length === 0) return;
    Alert.alert(
      translate('delete', resolvedLangRef.current),
      translate('deleteItemsConfirm', resolvedLangRef.current, { count: ids.length }),
      [
        { text: translate('cancel', resolvedLangRef.current), style: 'cancel' },
        {
          text: translate('delete', resolvedLangRef.current),
          style: 'destructive',
          onPress: async () => {
            for (const id of ids) await remove(id);
            setLibSelectMode(false);
            setLibSelected(new Set());
          },
        },
      ]
    );
  }, [libSelected, remove]);

  const mediaCount  = allVideos.length;
  const sheetMediaCount = pickerVideos.length;
  const activeCount = active.length;

  // ─────────────────────────────────────────────────────────
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <View style={[s.root, { backgroundColor: t.bg }]}>
        <SafeAreaView style={[s.flex, IS_ANDROID && { paddingTop: TOP_PAD }]}>
          <ExpoStatusBar style={isDark ? 'light' : 'dark'} />



        {/* ══════════════════════════════════════════════════ */}
        {/*  HOME TAB                                         */}
        {/* ══════════════════════════════════════════════════ */}
        {tab === 'home' && (
          <View style={s.flex}>
            <View style={s.homeLogoContainer}>
              <View style={s.logoGlowWrap}>
                <Image source={require('./assets/logo.png')} style={s.homeLogoImage} />
              </View>
              <Text style={[s.homeLogoTitle, { color: t.ink }]}>FCDownloader</Text>
            </View>

            <ScrollView
              style={s.flex}
              contentContainerStyle={[s.homeScroll, { paddingBottom: BOTTOM_PAD + 100 }]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* Paste card */}
              <View style={[s.pasteCard, { backgroundColor: t.card, borderColor: t.sep, borderWidth: 1 }, subtleShadow]}>
                <Text style={[s.pasteLabel, { color: t.ink2, fontSize: fs(12), textAlign: 'center' }]}>
                  {translate('videoOrPageLink', resolvedLanguage)}
                </Text>
                <TextInput
                  style={[s.pasteInput, { backgroundColor: t.card2, color: t.ink, fontSize: fs(15), textAlign: 'center' }]}
                  value={pasteUrl}
                  onChangeText={(text) => {
                    const delta = Math.abs(text.length - pasteUrl.length);
                    if (delta >= 6) {
                      const m = text.match(/https?:\/\/[^\s<>"'`\\]+/i);
                      if (m) {
                        const url = extractFirstUrl(m[0]);
                        if (url !== text.trim()) {
                          setPasteUrl(url);
                          return;
                        }
                      }
                    }
                    setPasteUrl(text);
                  }}
                  placeholder="Paste a link..."
                  placeholderTextColor={t.ink3}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="done"
                  onSubmitEditing={handleHomeDownload}
                  editable={!extracting}
                />
                <View style={s.homeActionRow}>
                  <Pressable
                    android_ripple={RIPPLE}
                    style={[s.pasteBtn, { borderColor: t.sep, backgroundColor: t.card2 }, extracting && { opacity: 0.5 }]}
                    onPress={handleHomePaste}
                    disabled={extracting}
                  >
                    <Text style={[s.pasteBtnLabel, { color: t.ink, fontSize: fs(15) }]}>Paste</Text>
                  </Pressable>
                  <Pressable
                    android_ripple={{ color: 'rgba(255,255,255,0.15)', borderless: false }}
                    style={[s.primaryBtn, s.homeDownloadBtn, { backgroundColor: t.btn }, extracting && { opacity: 0.5 }]}
                    onPress={handleHomeDownload}
                    disabled={extracting}
                  >
                    <Text style={[s.primaryBtnLabel, { color: t.btnTxt, fontSize: fs(16) }]}>
                      {extracting ? translate('finding', resolvedLanguage) : translate('download', resolvedLanguage)}
                    </Text>
                  </Pressable>
                </View>
                <Pressable onPress={() => setTab('browser')} hitSlop={S.xs} style={s.browseLink}>
                  <Text style={[s.browseLinkLabel, { color: t.ink2, fontSize: fs(13), textAlign: 'center' }]}>
                    or browse the web →
                  </Text>
                </Pressable>
                <Text style={[s.browseHint, { color: t.ink3, fontSize: fs(11), textAlign: 'center' }]}>
                  {translate('browseHint', resolvedLanguage)}
                </Text>
              </View>

              {/* Active downloads (V3 Simple rows with slim progress bars) */}
              {active.length > 0 && (
                <View style={s.section}>
                  <Text style={[s.sectionLabel, { color: t.ink2, fontSize: fs(11), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                    {translate('inProgress', resolvedLanguage).toUpperCase()}
                  </Text>
                  {active.map((task) => {
                    return (
                      <View key={task.id} style={[s.homeActiveRow, { backgroundColor: t.card, borderColor: t.sep, borderWidth: 1 }, subtleShadow]}>
                        <View style={[s.homeActiveHeader, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
                          <Text style={[s.homeActiveTitle, { color: t.ink, fontSize: fs(14) }]} numberOfLines={1}>
                            {mediaSourceName(task.media)} · {Math.round(task.progress * 100)}%
                          </Text>
                          <Pressable onPress={() => cancel(task.id)} hitSlop={S.xs}>
                            <Icon name="close" size={18} color={t.ink2} />
                          </Pressable>
                        </View>
                        <View style={[s.progressTrack, { backgroundColor: t.card2, marginTop: S.xs }]}>
                          <View style={[s.progressFill, { backgroundColor: getPlatformColor(task.media),
                            width: `${Math.round(task.progress * 100)}%` as `${number}%` }]} />
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}

              {/* Empty state */}
              {active.length === 0 && allTasks.length === 0 && (
                <View style={s.emptyHome}>
                  <Text style={[s.emptyHomeIcon, { color: t.ink3 }]}>↓</Text>
                  <Text style={[s.emptyHomeText, { color: t.ink2, fontSize: fs(14) }]}>
                    {translate('noDownloads', resolvedLanguage)}
                  </Text>
                </View>
              )}
              {active.length === 0 && allTasks.length > 0 && (
                <Pressable android_ripple={RIPPLE} style={[s.libraryLink, { backgroundColor: t.card }, subtleShadow]}
                  onPress={() => setTab('library')}>
                  <Text style={[s.libraryLinkLabel, { color: t.ink, fontSize: fs(14) }]}>
                    {allTasks.length === 1 ? translate('itemInLibrary', resolvedLanguage) : translate('itemsInLibrary', resolvedLanguage, { count: allTasks.length })}
                  </Text>
                  <Text style={[{ color: t.ink2, fontSize: fs(14) }]}>→</Text>
                </Pressable>
              )}
            </ScrollView>
          </View>
        )}

      {/* ══════════════════════════════════════════════════ */}
      {/*  BROWSER TAB                                      */}
      {/* ══════════════════════════════════════════════════ */}
      {tab === 'browser' && (
        <View style={s.flex}>
          {/* Two-row navbar */}
          <View style={[s.navBar, { backgroundColor: t.card, borderBottomColor: t.sep, borderBottomWidth: 1 }]}>
            {/* Row 1 */}
            <View style={[s.navBarTopRow, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
              <Pressable
                android_ripple={RIPPLE_BL}
                onPress={() => webviewRef.current?.goBack()}
                hitSlop={S.sm}
                style={s.navRowBtn}
              >
                <Icon name="chevron-back" size={24} color={t.ink} />
              </Pressable>
              
              <Text style={[s.browserTitle, { color: t.ink }]}>
                {translate('browse', resolvedLanguage).toUpperCase()}
              </Text>
              
              <View style={s.navRowBtn} />
            </View>
            
            {/* Row 2 */}
            <View style={[s.addressFieldWrap, { backgroundColor: t.card2, borderColor: t.sep, borderWidth: 1 }, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
              <Icon name="search-outline" size={18} color={t.ink3} style={{ marginHorizontal: S.xs }} />
              <TextInput
                style={[s.addressField, { color: t.ink, fontSize: fs(14), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}
                value={browserInput}
                onChangeText={setBrowserInput}
                onSubmitEditing={navigateBrowser}
                placeholder={translate('searchOrEnterUrl', resolvedLanguage)}
                placeholderTextColor={t.ink3}
                returnKeyType="go"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                selectTextOnFocus
              />
              <Pressable
                android_ripple={RIPPLE_BL}
                style={s.nestedReloadBtn}
                onPress={() => webviewRef.current?.reload()}
                hitSlop={S.xs}
              >
                <Icon name="refresh" size={18} color={t.ink2} />
              </Pressable>
            </View>
          </View>

          <View style={s.flex}>
            {loadedUrl === 'about:blank' ? (
              <View style={[s.flex, s.center, { backgroundColor: t.bg }]}>
                <Text style={[s.emptyHomeText, { color: t.ink2, fontSize: fs(14) }]}>
                  {translate('enterUrlToBrowse', resolvedLanguage)}
                </Text>
              </View>
            ) : (
              <BrowserView ref={webviewRef} initialUrl={loadedUrl} key={loadedUrl}
                onMessage={onMessage}
                onNavigationChange={(url) => { setBrowserInput(url); onPageChange(url); }}
                onExtractPage={extractBrowserPage}
                onLoadEnd={(e) => handleBrowserLoadEnd(e.nativeEvent.url)}
                style={StyleSheet.absoluteFill} />
            )}

            {loadedUrl !== 'about:blank' && (
              <Pressable
                android_ripple={RIPPLE}
                accessibilityRole="button"
                accessibilityLabel={`${translate('scan', resolvedLanguage)} ${translate('media', resolvedLanguage)}`}
                onPress={scanBrowserPage}
                hitSlop={S.sm}
                style={({ pressed }) => [
                  s.scanFab,
                  {
                    backgroundColor: t.btn,
                    borderColor: isDark ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.9)',
                  },
                  resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' },
                  pressed && s.scanFabPressed,
                ]}
              >
                <Icon name="scan-outline" size={20} color={t.btnTxt} />
                <Text style={[s.scanFabLabel, { color: t.btnTxt, fontSize: fs(14) }]} numberOfLines={1}>
                  {translate('scan', resolvedLanguage)}
                </Text>
              </Pressable>
            )}

            <Pressable
              android_ripple={RIPPLE}
              accessibilityRole="button"
              accessibilityLabel={
                mediaCount === 1
                  ? translate('mediaItemFound', resolvedLanguage)
                  : translate('mediaItemsFound', resolvedLanguage, { count: mediaCount })
              }
              style={({ pressed }) => [
                s.mediaFab,
                {
                  backgroundColor: mediaCount > 0 ? t.btn : t.card,
                  borderColor: mediaCount > 0
                    ? (isDark ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.9)')
                    : t.sep,
                },
                pressed && s.mediaFabPressed,
              ]}
              onPress={() => {
                setUniversalPickerOpen(false);
                setVideosOpen(true);
              }}
            >
              <Icon
                name={mediaCount > 0 ? 'download' : 'download-outline'}
                size={18}
                color={mediaCount > 0 ? t.btnTxt : t.ink2}
              />
              <Text
                style={[
                  s.mediaFabCount,
                  {
                    color: mediaCount > 0 ? t.btnTxt : t.ink,
                    fontSize: fs(15),
                  },
                ]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
              >
                {mediaCount}
              </Text>
            </Pressable>

            {/* Floating bookmark FAB */}
            {loadedUrl !== 'about:blank' && (
              <Pressable
                android_ripple={{ color: 'rgba(255,255,255,0.2)', borderless: true }}
                style={[s.bmFab, {
                  backgroundColor: isSaved(loadedUrl, bookmarks) ? t.btn : t.card,
                  bottom: 156,
                  ...(IS_IOS
                    ? { shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }
                    : { elevation: 5 }),
                }]}
                onPress={() => toggleBM(loadedUrl, getPageTitle(loadedUrl))}
              >
                <Icon
                  name={isSaved(loadedUrl, bookmarks) ? 'bookmark' : 'bookmark-outline'}
                  size={22}
                  color={isSaved(loadedUrl, bookmarks) ? t.btnTxt : t.ink2}
                />
              </Pressable>
            )}
          </View>

          {activeCount > 0 && (
            <Pressable style={[s.activeStrip, { backgroundColor: t.bg, borderTopColor: t.sep }]}
              onPress={() => setTab('library')}>
              <View style={[s.activeStripBar, { backgroundColor: t.card2 }]}>
                <View style={[s.activeStripFill, { backgroundColor: t.btn,
                  width: `${Math.round((active[0]?.progress ?? 0) * 100)}%` as `${number}%` }]} />
              </View>
              <Text style={[s.activeStripLabel, { color: t.ink2, fontSize: fs(11), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                {translate('inProgress', resolvedLanguage)}: {activeCount}
              </Text>
            </Pressable>
          )}
        </View>
      )}


      {/* ══════════════════════════════════════════════════ */}
      {/*  LIBRARY TAB                                      */}
      {/* ══════════════════════════════════════════════════ */}
      {tab === 'library' && (
        <View style={s.flex}>
          <View style={[s.topBar, { backgroundColor: t.bg, borderBottomColor: t.sep }]}>
            {libSelectMode ? (
              <>
                <Pressable
                  onPress={exitLibSelectMode}
                  hitSlop={S.sm}
                  android_ripple={RIPPLE_BL}
                  style={s.librarySelectEdge}>
                  <Text style={[{ color: t.ink, fontSize: fs(15) }]}>{translate('cancel', resolvedLanguage)}</Text>
                </Pressable>
                <Pressable
                  onPress={selectAllLib}
                  hitSlop={S.sm}
                  android_ripple={RIPPLE_BL}
                  style={s.librarySelectCenter}>
                  <Text style={[{ color: t.btn, fontSize: fs(15), fontWeight: '500' }]}>
                    {libSelected.size === history.length && history.length > 0 ? translate('deselectAll', resolvedLanguage) : translate('selectAll', resolvedLanguage)}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={deleteLibSelected}
                  hitSlop={S.sm}
                  android_ripple={RIPPLE_BL}
                  disabled={libSelected.size === 0}
                  style={[s.librarySelectEdge, { alignItems: 'flex-end' }]}>
                  <Text style={[{ fontSize: fs(15), fontWeight: '500',
                    color: libSelected.size > 0 ? t.red : t.ink3 }]}>
                    {translate('delete', resolvedLanguage)}
                  </Text>
                </Pressable>
              </>
            ) : (
              <>
                {IS_IOS
                  ? <Text style={[s.largeTitleIOS, { color: t.ink, textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>{translate('library', resolvedLanguage)}</Text>
                  : <Text style={[s.titleAndroid, { color: t.ink, textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>{translate('library', resolvedLanguage)}</Text>
                }
                {history.length > 0 && (
                  <Pressable onPress={() => { setLibSelectMode(true); setLibSelected(new Set()); }}
                    hitSlop={S.sm} android_ripple={RIPPLE_BL}>
                    <Text style={[{ color: t.ink2, fontSize: fs(14), fontWeight: '600' }]}>{editLabel}</Text>
                  </Pressable>
                )}
              </>
            )}
          </View>

          {/* Scrolling category filter chips */}
          {allTasks.length > 0 && (
            <View style={s.chipContainer}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipScroll}>
                {(['all', 'videos', 'audio', 'failed'] as const).map((filterVal) => {
                  const isActive = libFilter === filterVal;
                  const label = translate(filterVal as TranslationKey, resolvedLanguage) || filterVal;
                  return (
                    <Pressable
                      key={filterVal}
                      onPress={() => setLibFilter(filterVal)}
                      style={[
                        s.chip,
                        {
                          backgroundColor: isActive ? t.ink : t.card,
                          borderColor: t.sep,
                          borderWidth: 1,
                        }
                      ]}
                    >
                      <Text style={[s.chipText, { color: isActive ? t.bg : t.ink }]}>
                        {label.toUpperCase()}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          )}

          {allTasks.length === 0 ? (
            <View style={[s.flex, s.center, { backgroundColor: t.bg }]}>
              <Text style={[s.emptyHomeIcon, { color: t.ink3 }]}>⊘</Text>
              <Text style={[s.emptyHomeText, { color: t.ink2, fontSize: fs(14) }]}>{translate('noDownloads', resolvedLanguage)}</Text>
              <Pressable onPress={() => setTab('home')} hitSlop={S.xs} style={{ marginTop: S.sm }}>
                <Text style={[s.browseLinkLabel, { color: t.ink2, fontSize: fs(13) }]}>
                  {translate('goHome', resolvedLanguage)}
                </Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView contentContainerStyle={[s.gridContent, { paddingBottom: BOTTOM_PAD + 80 }]}
              showsVerticalScrollIndicator={false}>

              {/* Active downloads */}
              {filteredActive.length > 0 && (
                <>
                  <Text style={[s.sectionLabel, { color: t.ink2, fontSize: fs(11), marginBottom: S.sm, textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                    {translate('inProgress', resolvedLanguage).toUpperCase()}
                  </Text>
                  {filteredActive.map((task) => {
                    const resolution = getMediaResolution(task.media);
                    const statusText = task.status === 'downloading' && task.totalSegments > 0
                      ? translate('parts', resolvedLanguage, { downloaded: task.downloadedSegments, total: task.totalSegments })
                      : task.status === 'assembling'        ? translate('assembling', resolvedLanguage)
                      : task.status === 'fetching_manifest' ? translate('readingStream', resolvedLanguage)
                      : translate('starting', resolvedLanguage);
                    const showThumbnail = getMediaKind(task.media) === 'video' || getMediaKind(task.media) === 'image';
                    const source = mediaSourceName(task.media);
                    return (
                      <View key={task.id} style={[s.libraryCard, { backgroundColor: t.card }, subtleShadow]}>
                        <View style={s.libraryCardLeft}>
                          {showThumbnail && task.media.thumbnailUrl ? (
                            <View style={s.thumbnailContainer}>
                              <Image source={{ uri: task.media.thumbnailUrl }} style={s.libraryThumbnail} />
                            </View>
                          ) : (
                            <View style={[s.sourceAvatar, { backgroundColor: t.card2 }]}>
                              <Text style={[s.sourceAvatarText, { color: t.ink, fontSize: fs(18) }]}>
                                {getInitial(source)}
                              </Text>
                            </View>
                          )}
                        </View>
                        <View style={s.libraryCardBody}>
                          <View style={s.libraryCardRow}>
                            <Text style={[s.libraryCardTitle, { color: t.ink, fontSize: fs(14), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]} numberOfLines={1}>
                              {source}
                            </Text>
                          </View>
                          <View style={[s.progressTrack, { backgroundColor: t.card2, marginVertical: S.xs }]}>
                            <View style={[s.progressFill, { backgroundColor: t.btn,
                              width: `${Math.round(task.progress * 100)}%` as `${number}%` }]} />
                          </View>
                          <Text style={[s.libraryCardSub, { color: t.ink2, fontSize: fs(11), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                            {compactMediaDetails(statusText, resolution)}
                          </Text>
                        </View>
                        <View style={s.libraryCardRight}>
                          <View style={[s.statusCircle, { borderColor: t.progress, borderWidth: 2 }]}>
                            <Text style={{ fontSize: 9, fontWeight: '700', color: t.progress }}>
                              {Math.round(task.progress * 100)}%
                            </Text>
                          </View>
                          <Pressable android_ripple={RIPPLE_BL} onPress={() => cancel(task.id)} hitSlop={S.xs}>
                            <Text style={{ color: t.ink2, fontSize: 11, fontWeight: '600', marginTop: S.xs }}>
                              {translate('cancel', resolvedLanguage)}
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  })}
                  {filteredHistory.length > 0 && <View style={[s.sep, { backgroundColor: t.sep }]} />}
                </>
              )}

              {/* Completed / failed / cancelled */}
              {filteredHistory.length > 0 && filteredActive.length > 0 && (
                <Text style={[s.sectionLabel, { color: t.ink2, fontSize: fs(11), marginBottom: S.sm, textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                  {translate('completed', resolvedLanguage).toUpperCase()}
                </Text>
              )}
              {filteredHistory.map((task) => {
                const source      = mediaSourceName(task.media);
                const quality     = getQuality(task.media.url, task.media.label);
                const resolution  = getMediaResolution(task.media);
                const size        = fileSizes[task.id];
                const isDone      = task.status === 'completed';
                const isFail      = task.status === 'failed';
                const canSaveToLibrary = !!task.localPlaylistPath && getMediaKind(task.media) !== 'audio';
                const isSelected  = libSelected.has(task.id);
                const showThumbnail = getMediaKind(task.media) === 'video' || getMediaKind(task.media) === 'image';
                const isVideo = getMediaKind(task.media) === 'video';

                const cardContent = (
                  <>
                    <View style={s.libraryCardLeft}>
                      {libSelectMode ? (
                        <View style={[s.selectCircle, isSelected
                          ? { backgroundColor: t.btn, borderColor: t.btn }
                          : { borderColor: t.ink3 }]}>
                          {isSelected && <Text style={{ color: t.btnTxt, fontSize: fs(13), fontWeight: '700' }}>✓</Text>}
                        </View>
                      ) : (
                        showThumbnail && task.media.thumbnailUrl ? (
                          <View style={s.thumbnailContainer}>
                            <Image source={{ uri: task.media.thumbnailUrl }} style={s.libraryThumbnail} />
                            {isVideo && isDone && (
                              <View style={s.thumbnailPlayOverlay}>
                                <View style={s.playCircle}>
                                  <Icon name="play" size={10} color="#000000" style={{ marginLeft: 2 }} />
                                </View>
                              </View>
                            )}
                          </View>
                        ) : (
                          <View style={[s.sourceAvatar,
                            { backgroundColor: isDone ? t.card2 : isFail ? t.redBg : t.card2 }]}>
                            <Text style={[s.sourceAvatarText,
                              { color: isFail ? t.red : t.ink, fontSize: fs(18) }]}>
                              {getInitial(source)}
                            </Text>
                          </View>
                        )
                      )}
                    </View>
                    <View style={s.libraryCardBody}>
                      <View style={s.libraryCardRow}>
                        <Text style={[s.libraryCardTitle, { color: t.ink, fontSize: fs(14), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]} numberOfLines={1}>
                          {source}
                        </Text>
                        {quality && (
                          <View style={[s.badge, { backgroundColor: t.card2 }]}>
                            <Text style={[s.badgeLabel, { color: t.ink2, fontSize: fs(10) }]}>{quality}</Text>
                          </View>
                        )}
                      </View>
                      <Text style={[s.libraryCardSub,
                        { color: isFail ? t.red : t.ink2, fontSize: fs(12), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]} numberOfLines={1}>
                        {isDone   ? `${translate('saved', resolvedLanguage)}${size ? `  ·  ${size}` : ''}`
                         : isFail ? (
                             task.errorCode === 'AUTH_REQUIRED' ? translate('authRequired', resolvedLanguage) :
                             task.errorCode === 'GEO_BLOCKED'   ? translate('geoBlocked', resolvedLanguage) :
                             task.errorCode === 'RATE_LIMITED'  ? translate('rateLimited', resolvedLanguage) :
                             (task.error ?? translate('failedError', resolvedLanguage, { error: '' }).replace(': ', '').replace('：', ''))
                           )
                         : translate('cancel', resolvedLanguage)}
                      </Text>
                      {resolution && (
                        <Text style={[s.libraryCardSub, { color: t.ink2, fontSize: fs(11), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]} numberOfLines={1}>
                          {resolution}
                        </Text>
                      )}

                      {!libSelectMode && (
                        <View style={[s.libraryActions, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
                          {isDone && task.localPlaylistPath && (
                            <>
                              <Pressable android_ripple={RIPPLE_BL}
                                style={[s.outlineBtn, { borderColor: t.sep }]}
                                onPress={() => handleExport(task)}>
                                <Text style={[s.outlineBtnLabel, { color: t.ink, fontSize: fs(12) }]}>{translate('share', resolvedLanguage)}</Text>
                              </Pressable>
                              {canSaveToLibrary && (
                                <Pressable android_ripple={RIPPLE_BL}
                                  style={[s.outlineBtn, { borderColor: t.sep }]}
                                  onPress={() => handleGallery(task)}>
                                  <Text style={[s.outlineBtnLabel, { color: t.ink, fontSize: fs(12) }]}>{translate('gallery', resolvedLanguage)}</Text>
                                </Pressable>
                              )}
                            </>
                          )}
                          {isFail && (
                            <Pressable android_ripple={RIPPLE_BL}
                              style={[s.outlineBtn, { borderColor: t.sep }]}
                              onPress={() => handleRetry(task)}>
                              <Text style={[s.outlineBtnLabel, { color: t.ink, fontSize: fs(12) }]}>{translate('retry', resolvedLanguage)}</Text>
                            </Pressable>
                          )}
                          <Pressable android_ripple={RIPPLE_BL}
                            style={[s.outlineBtn, { borderColor: t.redBg }]}
                            onPress={() => Alert.alert(translate('delete', resolvedLangRef.current), translate('removeBookmarkConfirm', resolvedLangRef.current, { title: source }), [
                              { text: translate('cancel', resolvedLangRef.current), style: 'cancel' },
                              { text: translate('delete', resolvedLangRef.current), style: 'destructive', onPress: () => remove(task.id) },
                            ])}>
                            <Text style={[s.outlineBtnLabel, { color: t.red, fontSize: fs(12) }]}>{translate('delete', resolvedLanguage)}</Text>
                          </Pressable>
                        </View>
                      )}
                    </View>

                    {!libSelectMode && (
                      <View style={s.libraryCardRight}>
                        {isDone ? (
                          <View style={[s.statusCircle, { backgroundColor: t.greenBg, borderColor: t.green, borderWidth: 1 }]}>
                            <Icon name="checkmark" size={16} color={t.green} />
                          </View>
                        ) : isFail ? (
                          <>
                            <View style={[s.statusCircle, { backgroundColor: t.redBg, borderColor: t.red, borderWidth: 1 }]}>
                              <Icon name="alert" size={16} color={t.red} />
                            </View>
                            <Pressable onPress={() => handleRetry(task)} style={s.retryTextBtn}>
                              <Text style={{ color: t.red, fontSize: 11, fontWeight: '600', marginTop: S.xs }}>
                                {translate('retry', resolvedLanguage)}
                              </Text>
                            </Pressable>
                          </>
                        ) : (
                          <View style={[s.statusCircle, { backgroundColor: t.card2, borderColor: t.sep, borderWidth: 1 }]}>
                            <Icon name="close" size={16} color={t.ink3} />
                          </View>
                        )}
                      </View>
                    )}
                  </>
                );

                return libSelectMode ? (
                  <Pressable key={task.id} android_ripple={RIPPLE}
                    onPress={() => toggleLibSelect(task.id)}
                    style={[s.libraryCard, subtleShadow,
                      { backgroundColor: isSelected ? t.card2 : t.card }]}>
                    {cardContent}
                  </Pressable>
                ) : (
                  <View key={task.id} style={[s.libraryCard, { backgroundColor: t.card }, subtleShadow]}>
                    {cardContent}
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/*  BOOKMARKS TAB                                    */}
      {/* ══════════════════════════════════════════════════ */}
      {tab === 'bookmarks' && (
        <View style={s.flex}>
          <View style={[s.topBar, { backgroundColor: t.bg, borderBottomColor: t.sep }]}>
            {IS_IOS
              ? <Text style={[s.largeTitleIOS, { color: t.ink, textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>{translate('bookmarks', resolvedLanguage)}</Text>
              : <Text style={[s.titleAndroid, { color: t.ink, textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>{translate('bookmarks', resolvedLanguage)}</Text>
            }
            {bookmarks.length > 0 && (
              <Pressable
                onPress={() => setBmEditMode(!bmEditMode)}
                hitSlop={S.sm}
                android_ripple={RIPPLE_BL}
              >
                <Text style={{ color: t.btn, fontSize: fs(14), fontWeight: '600' }}>
                  {bmEditMode ? translate('done', resolvedLanguage) : editLabel}
                </Text>
              </Pressable>
            )}
          </View>

          {bookmarks.length === 0 ? (
            <View style={[s.flex, s.center, { backgroundColor: t.bg }]}>
              <Text style={[s.emptyHomeIcon, { color: t.ink3 }]}>☆</Text>
              <Text style={[s.emptyHomeText, { color: t.ink2, fontSize: fs(14) }]}>
                {translate('noBookmarks', resolvedLanguage)}
              </Text>
              <Pressable onPress={() => setTab('browser')} hitSlop={S.xs} style={{ marginTop: S.sm }}>
                <Text style={[s.browseLinkLabel, { color: t.ink2, fontSize: fs(13) }]}>
                  {translate('browseToSave', resolvedLanguage)}
                </Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView contentContainerStyle={[s.bmListContent, { paddingBottom: BOTTOM_PAD + 80 }]}
              showsVerticalScrollIndicator={false}>
              {bookmarks.map((bm) => {
                let domain = '';
                try { domain = new URL(bm.url).hostname.replace(/^www\./, ''); } catch {}
                
                const domainLower = domain.toLowerCase();
                const isInstagram = domainLower.includes('instagram');
                const initials = getBookmarkInitials(domain);
                const avatarBg = getBookmarkColor(domain);

                const avatarContent = (
                  <Text style={[s.bmRowAvatarText, { color: '#FFFFFF', fontSize: fs(15), fontWeight: '700' }]}>
                    {initials}
                  </Text>
                );

                const avatarView = isInstagram ? (
                  <View style={[s.bmRowAvatar, { backgroundColor: '#C13584' }]}>
                    {avatarContent}
                  </View>
                ) : (
                  <View style={[s.bmRowAvatar, { backgroundColor: avatarBg }]}>
                    {avatarContent}
                  </View>
                );

                return (
                  <Pressable key={bm.id} android_ripple={RIPPLE}
                    style={[s.bmRow, { backgroundColor: t.card }, subtleShadow]}
                    onPress={() => {
                      if (bmEditMode) {
                        Alert.alert(translate('removeBookmark', resolvedLangRef.current), translate('removeBookmarkConfirm', resolvedLangRef.current, { title: bm.title || domain }), [
                          { text: translate('cancel', resolvedLangRef.current), style: 'cancel' },
                          { text: translate('remove', resolvedLangRef.current), style: 'destructive', onPress: () => removeBM(bm.id) },
                        ]);
                      } else {
                        setLoadedUrl(bm.url);
                        setBrowserInput(bm.url);
                        setTab('browser');
                      }
                    }}>
                    {avatarView}
                    <View style={s.bmRowBody}>
                      <Text style={[s.bmRowTitle, { color: t.ink, fontSize: fs(14), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]} numberOfLines={1}>
                        {bm.title || domain}
                      </Text>
                      {domain ? (
                        <Text style={[s.bmRowUrl, { color: t.ink2, fontSize: fs(12), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]} numberOfLines={1}>
                          {domain}
                        </Text>
                      ) : null}
                    </View>
                    {bmEditMode ? (
                      <Pressable
                        onPress={() => {
                          Alert.alert(translate('removeBookmark', resolvedLangRef.current), translate('removeBookmarkConfirm', resolvedLangRef.current, { title: bm.title || domain }), [
                            { text: translate('cancel', resolvedLangRef.current), style: 'cancel' },
                            { text: translate('remove', resolvedLangRef.current), style: 'destructive', onPress: () => removeBM(bm.id) },
                          ]);
                        }}
                        hitSlop={S.xs}
                        style={{ padding: S.xs }}
                      >
                        <Icon name="trash-outline" size={20} color={t.red} />
                      </Pressable>
                    ) : (
                      <Icon name="chevron-forward" size={18} color={t.ink3} />
                    )}
                  </Pressable>
                );
              })}
              
              <Text style={[s.browseHint, { color: t.ink3, fontSize: fs(12), marginTop: S.md, textAlign: 'center' }]}>
                Tap ☆ in the browser to save sites
              </Text>
            </ScrollView>
          )}
        </View>
      )}

      {tab === 'settings' && (
        <SettingsSheet
          inline
          theme={theme}
          fontSize={fontSize}
          language={language}
          onThemeChange={setTheme}
          onFontSizeChange={setFontSize}
          onLanguageChange={setLanguage}
          removeWatermark={removeWatermark}
          onRemoveWatermarkChange={saveRemoveWatermark}
          preferredQuality={preferredQuality}
          onQualityChange={savePreferredQuality}
          resolvedLanguage={resolvedLanguage}
          t={t}
        />
      )}

      {/* ── Tab bar ─────────────────────────────────────── */}
      <View style={[
        s.tabBar,
        {
          backgroundColor: t.glass.tabBg,
          borderColor: t.glass.tabBorder,
          borderWidth: 1,
          bottom: BOTTOM_PAD + 16,
        },
        resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }
      ]}>
        {(['home', 'library', 'bookmarks', 'browser', 'settings'] as Tab[]).map((id) => {
          const isActive = tab === id;
          let iconName: React.ComponentProps<typeof Icon>['name'];
          switch (id) {
            case 'home':
              iconName = isActive ? 'home' : 'home-outline';
              break;
            case 'library':
              iconName = isActive ? 'download' : 'download-outline';
              break;
            case 'bookmarks':
              iconName = isActive ? 'bookmark' : 'bookmark-outline';
              break;
            case 'browser':
              iconName = isActive ? 'globe' : 'globe-outline';
              break;
            case 'settings':
              iconName = isActive ? 'settings' : 'settings-outline';
              break;
          }
          return (
            <Pressable
              key={id}
              android_ripple={RIPPLE_BL}
              style={s.tabItem}
              onPress={() => setTab(id)}
            >
              {isActive ? (
                <View style={[
                  s.tabPill,
                  {
                    backgroundColor: t.glass.pillActive,
                  }
                ]}>
                  <Icon name={iconName} size={22} color={t.glass.pillActiveTxt} />
                </View>
              ) : (
                <Icon name={iconName} size={22} color={t.ink2} />
              )}
            </Pressable>
          );
        })}
      </View>

      {/* ══════════════════════════════════════════════════ */}
      {/*  VIDEOS SHEET (from browser)                      */}
      {/* ══════════════════════════════════════════════════ */}
      <Modal visible={videosOpen} transparent animationType="slide"
        onRequestClose={closeVideosSheet}>
        <Pressable style={s.backdrop} onPress={closeVideosSheet} />
        <View style={[s.sheet, { backgroundColor: t.bg }]}>
          <View style={[s.sheetHandle, { backgroundColor: t.ink3 }]} />

          {previewItem ? (
            /* ── Preview detail view ── */
            <>
              <View style={[s.sheetHead, { backgroundColor: t.bg }, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
                <Pressable android_ripple={RIPPLE_BL} onPress={() => setPreviewItem(null)} hitSlop={S.sm}>
                  <Text style={[s.sheetBackLabel, { color: t.ink2, fontSize: fs(14) }]}>{translate('back', resolvedLanguage)}</Text>
                </Pressable>
                <Pressable android_ripple={RIPPLE_BL}
                  style={[s.closeRound, { backgroundColor: t.card }]}
                  onPress={closeVideosSheet} hitSlop={S.sm}>
                  <Text style={[s.closeRoundLabel, { color: t.ink2 }]}>✕</Text>
                </Pressable>
              </View>

              <ScrollView contentContainerStyle={{ padding: S.md, paddingBottom: S.xl }}>
                {/* Source avatar */}
                <View style={s.previewAvatar}>
                  <View style={[s.previewAvatarCircle, { backgroundColor: t.card }]}>
                    <Text style={[s.previewAvatarText, { color: t.ink }]}>
                      {getInitial(mediaSourceName(previewItem))}
                    </Text>
                  </View>
                  <Text style={[s.previewSource, { color: t.ink, fontSize: fs(18) }]}>
                    {mediaSourceName(previewItem)}
                  </Text>
                  {(() => {
                    let domain = '';
                    try { domain = new URL(previewItem.pageUrl || previewItem.url).hostname.replace(/^www\./, ''); } catch {}
                    return domain ? (
                      <Text style={[s.previewDomain, { color: t.ink2, fontSize: fs(13) }]}>{domain}</Text>
                    ) : null;
                  })()}
                </View>

                {/* Metadata */}
                {getQuality(previewItem.url, previewItem.label) && (
                  <View style={[s.metaRow, { borderBottomColor: t.sep }, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
                    <Text style={[s.metaKey, { color: t.ink2, fontSize: fs(13) }]}>{translate('quality', resolvedLanguage)}</Text>
                    <Text style={[s.metaVal, { color: t.ink, fontSize: fs(13) }]}>
                      {getQuality(previewItem.url, previewItem.label)}
                    </Text>
                  </View>
                )}
                <View style={[s.metaRow, { borderBottomColor: t.sep }, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
                  <Text style={[s.metaKey, { color: t.ink2, fontSize: fs(13) }]}>{translate('format', resolvedLanguage)}</Text>
                  <Text style={[s.metaVal, { color: t.ink, fontSize: fs(13) }]}>
                    {getMediaFormat(previewItem)}
                  </Text>
                </View>
                {getMediaResolution(previewItem) && (
                  <View style={[s.metaRow, { borderBottomColor: t.sep }, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
                    <Text style={[s.metaKey, { color: t.ink2, fontSize: fs(13) }]}>{translate('resolution', resolvedLanguage)}</Text>
                    <Text style={[s.metaVal, { color: t.ink, fontSize: fs(13) }]}>
                      {getMediaResolution(previewItem)}
                    </Text>
                  </View>
                )}

                {selectableFormatOptions(previewItem).length > 0 && (
                  <View style={{ marginTop: S.md }}>
                    <Text style={[s.sectionLabel, { color: t.ink2, fontSize: fs(11), marginBottom: S.xs, textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                      {translate('formats', resolvedLanguage)}
                    </Text>
                    {selectableFormatOptions(previewItem).slice(0, 8).map((format) => {
                      const selected = selectedFormatId === format.id || (!selectedFormatId && format.id === previewItem.formatId);
                      return (
                        <Pressable
                          key={format.id}
                          android_ripple={RIPPLE}
                          onPress={() => setSelectedFormatId(format.id)}
                          style={[s.metaRow, { borderBottomColor: t.sep }, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
                          <Text style={[s.metaKey, { color: selected ? t.ink : t.ink2, fontSize: fs(13) }]}>
                            {selected ? translate('selected', resolvedLanguage) : format.id}
                          </Text>
                          <Text style={[s.metaVal, { color: t.ink, fontSize: fs(13) }]} numberOfLines={2}>
                            {formatOptionLabel(format)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}

                <Pressable
                  android_ripple={{ color: 'rgba(255,255,255,0.15)', borderless: false }}
                  style={[s.primaryBtn, { backgroundColor: t.btn, marginTop: S.lg }]}
                  onPress={() => handleDetectedDownload(previewItem)}>
                  <Text style={[s.primaryBtnLabel, { color: t.btnTxt, fontSize: fs(16) }]}>
                    {translate('download', resolvedLanguage)}
                  </Text>
                </Pressable>
                {getMediaKind(previewItem) !== 'image' && (
                  <Pressable
                    android_ripple={RIPPLE}
                    style={[s.secondaryBtn, { borderColor: t.sep, marginTop: S.sm }]}
                    onPress={() => handleDetectedAudioDownload(previewItem)}>
                    <Text style={[s.secondaryBtnLabel, { color: t.ink, fontSize: fs(15) }]}>
                      {translate('downloadAudio', resolvedLanguage)}
                    </Text>
                  </Pressable>
                )}
              </ScrollView>
            </>
          ) : (
            /* ── Video list ── */
            <>
              <View style={[s.sheetHead, { backgroundColor: t.bg }, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
                <Text style={[s.sheetTitle, { color: t.ink, fontSize: fs(20) }]}>
                  {universalPickerOpen
                    ? translate('chooseMediaToDownload', resolvedLanguage)
                    : sheetMediaCount > 0
                    ? (sheetMediaCount === 1 ? translate('mediaItemFound', resolvedLanguage) : translate('mediaItemsFound', resolvedLanguage, { count: sheetMediaCount }))
                    : translate('media', resolvedLanguage)}
                </Text>
                <Pressable android_ripple={RIPPLE_BL}
                  style={[s.closeRound, { backgroundColor: t.card }]}
                  onPress={closeVideosSheet} hitSlop={S.sm}>
                  <Text style={[s.closeRoundLabel, { color: t.ink2 }]}>✕</Text>
                </Pressable>
              </View>

              {!universalPickerOpen && pickerVideos.length > 0 && (
                <View style={[s.bulkDownloadRow, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
                  <Pressable android_ripple={RIPPLE}
                    style={[s.secondaryBtn, s.bulkDownloadBtn, { borderColor: t.sep }]}
                    onPress={handleDownloadAllDetected}>
                    <Text style={[s.secondaryBtnLabel, { color: t.ink, fontSize: fs(13) }]}>
                      {translate('downloadAll', resolvedLanguage)}
                    </Text>
                  </Pressable>
                  {pickerVideos.some((item) => getMediaKind(item) !== 'image') && (
                    <Pressable android_ripple={RIPPLE}
                      style={[s.secondaryBtn, s.bulkDownloadBtn, { borderColor: t.sep }]}
                      onPress={handleDownloadAllAudio}>
                      <Text style={[s.secondaryBtnLabel, { color: t.ink, fontSize: fs(13) }]}>
                        {translate('audioAll', resolvedLanguage)}
                      </Text>
                    </Pressable>
                  )}
                </View>
              )}

              <ScrollView style={{ maxHeight: 360 }}
                contentContainerStyle={{ paddingHorizontal: S.md, paddingBottom: S.sm }}
                showsVerticalScrollIndicator={false}>
                {pickerVideos.length === 0 && !mseActive && (
                  <View style={s.center}>
                    <Text style={[s.emptyHomeText, { color: t.ink2, fontSize: fs(14), textAlign: 'center',
                      paddingVertical: S.xl }]}>
                      {translate('browseForMedia', resolvedLanguage)}
                    </Text>
                  </View>
                )}
                {pickerVideos.map((item) => {
                  const source = universalPickerOpen
                    ? candidateDisplayTitle(item, pickerVideos)
                    : mediaSourceName(item);
                  const quality = getQuality(item.url, item.label) || getMediaFormat(item);
                  const resolution = getMediaResolution(item);
                  const candidateDetails = candidateSourceDetails(item);
                  return (
                    <Pressable key={item.id} android_ripple={RIPPLE}
                      style={[s.videoRow, { backgroundColor: t.card, borderBottomColor: t.sep }, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}
                      onPress={() => setPreviewItem(item)}>
                      <View style={[s.videoAvatar, { backgroundColor: t.card2 }]}>
                        <Text style={[s.videoAvatarText, { color: t.ink, fontSize: fs(15) }]}>
                          {getInitial(source)}
                        </Text>
                      </View>
                      <View style={[s.videoMeta, resolvedLanguage === 'ar' && { alignItems: 'flex-end' }]}>
                        <Text style={[s.videoSource, { color: t.ink, fontSize: fs(14), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>{source}</Text>
                        <Text style={[s.videoQuality, { color: t.ink2, fontSize: fs(12), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                          {compactMediaDetails(quality, resolution, candidateDetails)}
                        </Text>
                      </View>
                      <Pressable android_ripple={RIPPLE}
                        style={[s.dlBtn, { backgroundColor: t.btn }]}
                        onPress={() => handleDetectedDownload(item)}>
                        <Text style={[s.dlBtnLabel, { color: t.btnTxt, fontSize: fs(13) }]}>{translate('download', resolvedLanguage)}</Text>
                      </Pressable>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {/* Manual paste */}
              <View style={[s.sheetPasteRow, { borderTopColor: t.sep, backgroundColor: t.bg }, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
                <TextInput
                  style={[s.sheetPasteInput, { backgroundColor: t.card, color: t.ink, fontSize: fs(14), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}
                  value={pasteUrl}
                  onChangeText={setPasteUrl}
                  placeholder={translate('pasteMediaUrlPlaceholder', resolvedLanguage)}
                  placeholderTextColor={t.ink3}
                  autoCapitalize="none" autoCorrect={false}
                  keyboardType="url" returnKeyType="done"
                  onSubmitEditing={() => { closeVideosSheet(); handleHomeDownload(); }}
                  editable={!extracting}
                />
                <Pressable android_ripple={RIPPLE}
                  style={[s.dlBtn, { backgroundColor: t.btn }, extracting && { opacity: 0.5 }]}
                  onPress={() => { closeVideosSheet(); handleHomeDownload(); }}
                  disabled={extracting}>
                  <Text style={[s.dlBtnLabel, { color: t.btnTxt, fontSize: fs(14) }]}>
                    {extracting ? '…' : translate('add', resolvedLanguage)}
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </Modal>

      {/* ── Modals ──────────────────────────────────────── */}
        <Toast message={toast} />
        {/* Hidden WebView: runs the Sina Visitor System JS for Weibo sessions.
            m.weibo.cn serves the visitor HTML INLINE (title="Sina Visitor System") so
            onLoadEnd fires immediately on the visitor page before the JS runs. We use
            injectedJavaScript (runs after every navigation) to detect when the visitor
            JS has completed and the real Weibo page has loaded (different title), then
            extract cookies and signal. */}
        {IS_IOS && weiboPrewarmActive && (
          <WebView
            ref={(r) => { weiboWebViewRef.current = r; }}
            source={{ uri: 'https://m.weibo.cn/' }}
            style={s.hiddenWebView}
            injectedJavaScript={`
              (function() {
                if (window.location.hostname === 'm.weibo.cn' && document.title && document.title !== 'Sina Visitor System') {
                  window.ReactNativeWebView.postMessage('weibo_ready');
                }
              })();
              true;
            `}
            onMessage={(e) => {
              const msg = e.nativeEvent.data;
              if (msg === 'weibo_ready') {
                // Keep WebView alive so fetchWeiboStatuses can inject API calls.
                // Auto-dismiss after 60s as safety net.
                if (weiboAutoDismissRef.current) clearTimeout(weiboAutoDismissRef.current);
                weiboAutoDismissRef.current = setTimeout(() => {
                  weiboAutoDismissRef.current = null;
                  setWeiboPrewarmActive(false);
                }, 60_000);
                extractSessionCookies('https://m.weibo.cn/')
                  .then((cookies) => signalWeiboPrewarmComplete(cookies.length > 0))
                  .catch(() => signalWeiboPrewarmComplete(false));
              } else if (msg.startsWith('weibo_statuses:')) {
                const json = msg.slice('weibo_statuses:'.length);
                try {
                  signalWeiboFetchComplete(json === 'null' ? null : JSON.parse(json));
                } catch {
                  signalWeiboFetchComplete(null);
                }
              }
            }}
            onError={() => {
              if (weiboAutoDismissRef.current) { clearTimeout(weiboAutoDismissRef.current); weiboAutoDismissRef.current = null; }
              setWeiboPrewarmActive(false);
              signalWeiboPrewarmComplete(false);
            }}
          />
        )}
      </SafeAreaView>
      </View>
    </SafeAreaProvider>
  );
}

// ── Styles ────────────────────────────────────────────────────
const s = StyleSheet.create({
  root:   { flex: 1 },
  flex:   { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  sep:    { height: StyleSheet.hairlineWidth, marginVertical: S.md },
  hiddenWebView: { position: 'absolute', width: 0, height: 0, opacity: 0 },

  // ── Background Glows ──────────────────────────────────────
  bgGlow1: {
    position: 'absolute',
    width: 320,
    height: 320,
    borderRadius: 160,
    opacity: 1.0,
  },
  bgGlow2: {
    position: 'absolute',
    width: 320,
    height: 320,
    borderRadius: 160,
    opacity: 1.0,
  },

  // ── Top bar ───────────────────────────────────────────────
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: S.md,
    paddingVertical: IS_IOS ? S.md : S.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  largeTitleIOS: { fontSize: 28, fontWeight: '700', letterSpacing: 0.2 },
  titleAndroid:  { fontSize: 20, fontWeight: '600' },
  topBarCount:   { fontWeight: '500' },
  gearBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  gearIcon: { fontSize: 17 },

  // ── Home ──────────────────────────────────────────────────
  homeScroll: { padding: S.md, gap: S.md },
  homeLogoContainer: {
    alignItems: 'center',
    marginTop: S.xl * 1.5,
    marginBottom: S.md,
  },
  logoGlowWrap: {
    width: 110,
    height: 110,
    alignItems: 'center',
    justifyContent: 'center',
  },
  homeLogoImage: {
    width: 80,
    height: 80,
    resizeMode: 'contain',
  },
  homeLogoTitle: {
    fontSize: 22,
    fontWeight: '700',
    marginTop: S.sm,
    letterSpacing: 0.5,
  },
  pasteCard: {
    borderRadius: R.lg,
    padding: S.md,
    gap: S.sm,
  },
  pasteLabel: { fontWeight: '600', letterSpacing: 0.6, marginBottom: S.xs },
  pasteInput: {
    height: 50,
    borderRadius: R.md,
    paddingHorizontal: S.md,
    fontWeight: '400',
  },
  primaryBtn: {
    height: 52,
    borderRadius: 26, // Perfect pill
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnLabel: { fontWeight: '600' },
  homeActionRow: {
    flexDirection: 'row',
    gap: S.sm,
  },
  homeDownloadBtn: {
    flex: 1,
  },
  pasteBtn: {
    minWidth: 96,
    height: 52,
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: S.md,
  },
  pasteBtnLabel: { fontWeight: '600' },
  secondaryBtn: {
    height: 48,
    borderRadius: R.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnLabel: { fontWeight: '600' },
  bulkDownloadRow: {
    flexDirection: 'row',
    gap: S.sm,
    paddingHorizontal: S.md,
    paddingBottom: S.sm,
  },
  bulkDownloadBtn: {
    flex: 1,
    height: 40,
  },
  browseLink:      { alignItems: 'center', paddingVertical: S.xs },
  browseLinkLabel: { fontWeight: '400' },
  browseHint:      { alignSelf: 'center', textAlign: 'center', marginTop: 2, fontWeight: '400', opacity: 0.85 },

  section:      { gap: S.sm },
  sectionLabel: { fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' },

  homeActiveRow: {
    borderRadius: R.md,
    padding: S.md,
    gap: S.xs,
    marginBottom: S.sm,
  },
  homeActiveHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  homeActiveTitle: {
    fontWeight: '600',
  },

  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden' }, // height 8, border radius 4
  progressFill:  { height: 8, borderRadius: 4 },

  emptyHome:     { alignItems: 'center', paddingTop: S.xl * 2, gap: S.sm },
  emptyHomeIcon: { fontSize: 40, fontWeight: '200' },
  emptyHomeText: { fontWeight: '400', textAlign: 'center' },

  libraryLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: R.md,
    padding: S.md,
  },
  libraryLinkLabel: { fontWeight: '500' },

  // ── Browser ───────────────────────────────────────────────
  navBar: {
    flexDirection: 'column',
    alignItems: 'center',
    paddingHorizontal: S.md,
    paddingVertical: S.sm,
    gap: S.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  navBarTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: S.xs,
  },
  navRowBtn: {
    width: IS_IOS ? 44 : 36,
    height: IS_IOS ? 44 : 36,
    borderRadius: IS_IOS ? 22 : 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  browserTitle: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
  },
  addressFieldWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    height: 40,
    flex: 1,
    paddingHorizontal: S.sm,
  },
  addressField: {
    flex: 1,
    height: 40,
    paddingHorizontal: S.sm,
  },
  nestedReloadBtn: {
    padding: S.xs,
  },
  scanFab: {
    position: 'absolute',
    bottom: 84,
    left: S.lg,
    minWidth: 104,
    height: 52,
    borderRadius: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: S.xs,
    paddingHorizontal: S.md,
    borderWidth: StyleSheet.hairlineWidth,
    zIndex: 30,
    ...(IS_IOS
      ? { shadowColor: '#000', shadowOpacity: 0.24, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } }
      : { elevation: 8 }),
  },
  scanFabLabel: {
    fontWeight: '800',
  },
  scanFabPressed: {
    opacity: 0.86,
    transform: [{ scale: 0.97 }],
  },
  mediaFab: {
    position: 'absolute',
    bottom: 84,
    right: S.lg,
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    borderWidth: StyleSheet.hairlineWidth,
    zIndex: 30,
    ...(IS_IOS
      ? { shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } }
      : { elevation: 8 }),
  },
  mediaFabPressed: {
    opacity: 0.86,
    transform: [{ scale: 0.96 }],
  },
  mediaFabCount: { fontWeight: '900', lineHeight: 17 },

  activeStrip:    { paddingHorizontal: S.md, paddingVertical: S.sm, borderTopWidth: StyleSheet.hairlineWidth, gap: S.xs },
  activeStripBar: { height: 2, borderRadius: 1, overflow: 'hidden' },
  activeStripFill: { height: 2, borderRadius: 1 },
  activeStripLabel: { fontWeight: '400' },

  // ── Library ───────────────────────────────────────────────
  gridContent: { padding: S.md, gap: S.sm },
  chipContainer: {
    paddingVertical: S.sm,
    paddingHorizontal: S.md,
  },
  chipScroll: {
    gap: S.sm,
    flexDirection: 'row',
  },
  chip: {
    paddingHorizontal: S.md,
    paddingVertical: 6,
    borderRadius: 16,
  },
  chipText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  libraryCard: {
    flexDirection: 'row',
    borderRadius: R.lg,
    overflow: 'hidden',
    gap: S.md,
    padding: S.md,
  },
  libraryCardLeft: { alignItems: 'center', justifyContent: 'flex-start', paddingTop: 2 },
  sourceAvatar: {
    width: 44,
    height: 44,
    borderRadius: R.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceAvatarText: { fontWeight: '600' },
  thumbnailContainer: {
    width: 44,
    height: 44,
    borderRadius: R.md,
    overflow: 'hidden',
    position: 'relative',
  },
  libraryThumbnail: {
    width: '100%',
    height: '100%',
  },
  thumbnailPlayOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  libraryCardBody: { flex: 1, gap: S.xs },
  libraryCardRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  libraryCardTitle: { flex: 1, fontWeight: '600' },
  libraryCardPct:   { fontWeight: '400' },
  libraryCardSub:   { fontWeight: '400' },
  libraryActions: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, marginTop: S.xs },
  libraryCardRight: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 48,
  },
  statusCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryTextBtn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  librarySelectEdge: {
    width: 88,
    minHeight: 36,
    justifyContent: 'center',
  },
  librarySelectCenter: {
    flex: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },

  selectCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },

  badge: {
    paddingHorizontal: S.xs + 2,
    paddingVertical: 2,
    borderRadius: S.xs,
  },
  badgeLabel: { fontWeight: '600', letterSpacing: 0.2 },

  outlineBtn: {
    height: 30,
    paddingHorizontal: S.sm + 2,
    borderRadius: R.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlineBtnLabel: { fontWeight: '500' },

  // ── Tab bar ───────────────────────────────────────────────
  tabBar: {
    position: 'absolute',
    left: 24,
    right: 24,
    height: 56,
    borderRadius: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tabPill: {
    height: 38,
    borderRadius: 19,
    width: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabLabel: {},
  tabDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginTop: 3,
  },
  tabSep: {
    width: StyleSheet.hairlineWidth,
    marginVertical: S.md,
  },

  // ── Videos sheet ─────────────────────────────────────────
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    borderTopLeftRadius: R.xl,
    borderTopRightRadius: R.xl,
    paddingBottom: BOTTOM_PAD + S.md,
    maxHeight: '88%',
    ...(IS_IOS
      ? { shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 20, shadowOffset: { width: 0, height: -4 } }
      : { elevation: 8 }),
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: S.sm,
    marginBottom: S.md,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: S.md,
    marginBottom: S.md,
  },
  sheetTitle:     { fontWeight: '700' },
  sheetBackLabel: { fontWeight: '400' },
  closeRound: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeRoundLabel: { fontSize: 13, fontWeight: '500' },

  // ── Preview ───────────────────────────────────────────────
  previewAvatar: { alignItems: 'center', paddingVertical: S.lg, gap: S.sm },
  previewAvatarCircle: {
    width: 72,
    height: 72,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewAvatarText: { fontSize: 32, fontWeight: '600' },
  previewSource:     { fontWeight: '700' },
  previewDomain:     { fontWeight: '400' },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: S.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  metaKey: { fontWeight: '400' },
  metaVal: { fontWeight: '500' },

  // ── Video row (list in sheet) ─────────────────────────────
  videoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.sm,
    borderRadius: R.lg,
    padding: S.sm + 2,
    marginBottom: S.sm,
  },
  videoAvatar: {
    width: 40,
    height: 40,
    borderRadius: R.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  videoAvatarText: { fontWeight: '600' },
  videoMeta:       { flex: 1, gap: 2 },
  videoSource:     { fontWeight: '500' },
  videoQuality:    { fontWeight: '400' },
  dlBtn: {
    height: 34,
    paddingHorizontal: S.md,
    borderRadius: R.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  dlBtnLabel: { fontWeight: '600' },

  // ── Bookmarks tab ─────────────────────────────────────────
  bmListContent: { padding: S.md, gap: S.sm },
  bmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.md,
    borderRadius: R.lg,
    padding: S.md,
  },
  bmRowAvatar: {
    width: 40,
    height: 40,
    borderRadius: R.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  bmRowAvatarText: { fontWeight: '600' },
  bmRowBody:    { flex: 1, gap: 2 },
  bmRowTitle:   { fontWeight: '500' },
  bmRowUrl:     { fontWeight: '400' },
  bmRowChevron: { fontSize: 20, fontWeight: '300', paddingHorizontal: S.xs },

  // ── Floating bookmark FAB ─────────────────────────────────
  bmFab: {
    position: 'absolute',
    bottom: 80,
    right: S.lg,
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  bmFabIcon: { fontSize: 22, lineHeight: 26 },

  // ── Sheet paste row ───────────────────────────────────────
  sheetPasteRow: {
    flexDirection: 'row',
    gap: S.sm,
    paddingHorizontal: S.md,
    paddingTop: S.md,
    paddingBottom: S.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetPasteInput: {
    flex: 1,
    height: 42,
    borderRadius: R.md,
    paddingHorizontal: S.md,
  },
});

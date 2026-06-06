import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import WebView from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import * as Linking from 'expo-linking';

import BrowserView from './src/components/BrowserView';
import Toast, { ToastMessage } from './src/components/Toast';
import VideoPlayerModal from './src/components/VideoPlayerModal';
import SettingsSheet from './src/components/SettingsSheet';
import { translate, TranslationKey } from './src/constants/translations';

import { useMediaDetection } from './src/hooks/useMediaDetection';
import { useDownloadManager } from './src/hooks/useDownloadManager';
import { useBookmarks } from './src/hooks/useBookmarks';
import { useSettings } from './src/hooks/useSettings';
import { DetectedMedia, DownloadTask } from './src/types';
import { extractionManager } from './src/lib/extractionManager';
import { ServerExtractOptions, setRemoveWatermark, setPreferredQuality } from './src/lib/serverExtractor';
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

function getPlatformColor(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('youtube') || lower.includes('youtu.be')) {
    return '#A855F7'; // YouTube purple/violet
  }
  if (lower.includes('tiktok')) {
    return '#06B6D4'; // TikTok cyan/blue
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

function compactMediaDetails(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part))
    .filter((part, index, all) => all.indexOf(part) === index)
    .join('  |  ');
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

  // ── Navigation ────────────────────────────────────────────
  const [tab, setTab]               = useState<Tab>('home');
  const [pasteUrl, setPasteUrl]     = useState('');
  const [browserInput, setBrowserInput] = useState('');
  const [loadedUrl, setLoadedUrl]   = useState('about:blank');

  // ── UI ────────────────────────────────────────────────────
  const [videosOpen, setVideosOpen]     = useState(false);
  const [previewItem, setPreviewItem]   = useState<DetectedMedia | null>(null);
  const [selectedFormatId, setSelectedFormatId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [playingPath, setPlayingPath]   = useState<string | null>(null);
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
    captureSessionSnapshot,
  } = useMediaDetection();
  const { bookmarks, toggle: toggleBM, remove: removeBM, isSaved } = useBookmarks();

  const showToast = useCallback((msg: string, type: ToastMessage['type'] = 'info') => {
    setToast({ id: String(Date.now()), text: msg, type });
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
    onError:    useCallback((task: DownloadTask) =>
      showToast(translate('failedError', resolvedLangRef.current, { error: task.error ?? 'unknown error' }), 'error'), [showToast]),
  });

  const [extractionQueue, setExtractionQueue] = useState<string[]>([]);

  const runExtractionAndDownload = useCallback(async (url: string) => {
    let targetUrl = url.trim();
    if (!targetUrl) return;
    if (!targetUrl.startsWith('http')) targetUrl = `https://${targetUrl}`;

    if (isDirectMediaUrl(targetUrl)) {
      const item: DetectedMedia = {
        id: `home_${Date.now()}`, url: targetUrl, pageUrl: targetUrl, userAgent: '',
        timestamp: Date.now(),
        mediaType: guessMediaType(targetUrl),
        mediaKind: getMediaKind({ url: targetUrl }),
        confidence: 0.75, provenance: 'manual',
      };
      await enqueue(item);
      setPasteUrl('');
      showToast(translate('downloadStarted', resolvedLangRef.current), 'success');
      setTab('library');
      return;
    }

    setExtracting(true);
    try {
      const items = await extractionManager.extractMedia(targetUrl);
      if (items.length > 0) {
        for (const item of items) await enqueue(item);
        setPasteUrl('');
        showToast(
          items.length === 1
            ? translate('startedDownload', resolvedLangRef.current)
            : translate('startedDownloads', resolvedLangRef.current, { count: items.length }),
          'success'
        );
        setTab('library');
        return;
      }
      showToast(translate('openingInBrowserScan', resolvedLangRef.current), 'info');
    } catch {
      showToast(translate('openingInBrowser', resolvedLangRef.current), 'info');
    } finally {
      setExtracting(false);
    }
    setLoadedUrl(targetUrl); setBrowserInput(targetUrl); setTab('browser');
  }, [enqueue, showToast, setPasteUrl, setTab, setLoadedUrl, setBrowserInput]);

  useEffect(() => {
    if (extracting || extractionQueue.length === 0) return;
    const nextUrl = extractionQueue[0];
    setExtractionQueue((prev) => prev.slice(1));
    runExtractionAndDownload(nextUrl);
  }, [extracting, extractionQueue, runExtractionAndDownload]);

  // ── Start download and extraction ───────────────────────
  const startDownloadAndExtraction = useCallback((url: string) => {
    const targetUrl = url.trim();
    if (!targetUrl) return;
    setExtractionQueue((prev) => [...prev, targetUrl]);
  }, []);

  const handleIncomingUrl = useCallback((raw: string) => {
    try {
      const parsed = Linking.parse(raw);
      if (parsed.path === 'share' || parsed.hostname === 'share') {
        const mediaUrl = parsed.queryParams?.url ? String(parsed.queryParams.url) : null;
        if (mediaUrl) {
          setPasteUrl(mediaUrl);
          setTab('home');
          showToast(translate('linkReceived', resolvedLangRef.current), 'success');
          startDownloadAndExtraction(mediaUrl);
        }
      }
    } catch {}
  }, [showToast, startDownloadAndExtraction, setPasteUrl, setTab]);

  useEffect(() => {
    Linking.getInitialURL().then((url) => { if (url) handleIncomingUrl(url); });
    const sub = Linking.addEventListener('url', ({ url }) => handleIncomingUrl(url));
    return () => sub.remove();
  }, [handleIncomingUrl]);

  // ── Detected videos ───────────────────────────────────────
  const allVideos = useMemo<DetectedMedia[]>(() => {
    const seen = new Set(detected.map((m) => m.url));
    const fromNet: DetectedMedia[] = networkLog
      .filter((url) => isRuntimeDownloadCandidate(url, loadedUrl) && !seen.has(url))
      .map((url) => ({
        id: `net_${url}`, url, pageUrl: loadedUrl, userAgent: '',
        timestamp: Date.now(),
        mediaType: guessMediaType(url),
        mediaKind: getMediaKind({ url }),
      }));
    return smartDedup([...detected, ...fromNet]);
  }, [detected, networkLog, loadedUrl]);

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
      const items = await extractionManager.extractMedia(url, session);
      if (items.length > 0) {
        for (const item of items) await enqueue(item);
        showToast(
          items.length === 1
            ? translate('startedDownload', resolvedLangRef.current)
            : translate('startedDownloads', resolvedLangRef.current, { count: items.length }),
          'success'
        );
        setTab('library');
        return;
      }
      showToast(translate('scanningPage', resolvedLangRef.current), 'info');
      scanBrowserPage();
    } finally {
      setExtracting(false);
    }
  }, [browserSessionFor, enqueue, extracting, loadedUrl, scanBrowserPage, showToast]);

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
  const handleHomeDownload = useCallback(() => {
    startDownloadAndExtraction(pasteUrl);
  }, [pasteUrl, startDownloadAndExtraction]);

  // ── Browser: download detected video ─────────────────────
  const handleDetectedDownload = useCallback(async (item: DetectedMedia) => {
    setVideosOpen(false);
    setPreviewItem(null);
    const selected = selectedFormatId && item.availableFormats?.some((f) => f.id === selectedFormatId)
      ? item.availableFormats.find((f) => f.id === selectedFormatId)
      : null;
    await enqueue(selected
      ? {
          ...item,
          formatId: selected.id,
          label: selected.label ?? item.label,
          mimeType: selected.ext ? `${item.mediaKind === 'audio' ? 'audio' : 'video'}/${selected.ext}` : item.mimeType,
          forceServerDownload: true,
        }
      : item);
    setSelectedFormatId(null);
    showToast(translate('downloadStarted', resolvedLangRef.current), 'success');
    setTab('library');
  }, [enqueue, selectedFormatId, showToast]);

  const handleDetectedAudioDownload = useCallback(async (item: DetectedMedia) => {
    setVideosOpen(false);
    setPreviewItem(null);
    await enqueue({
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
    showToast(translate('audioDownloadStarted', resolvedLangRef.current), 'success');
    setTab('library');
  }, [enqueue, showToast]);

  const handleDownloadAllDetected = useCallback(async () => {
    if (!allVideos.length) return;
    setVideosOpen(false);
    setPreviewItem(null);
    for (const item of allVideos) await enqueue(item);
    showToast(
      allVideos.length === 1
        ? translate('startedDownload', resolvedLangRef.current)
        : translate('startedDownloads', resolvedLangRef.current, { count: allVideos.length }),
      'success'
    );
    setTab('library');
  }, [allVideos, enqueue, showToast]);

  const handleDownloadAllAudio = useCallback(async () => {
    const audioItems = allVideos.filter((item) => getMediaKind(item) !== 'image');
    if (!audioItems.length) return;
    setVideosOpen(false);
    setPreviewItem(null);
    for (const item of audioItems) {
      await enqueue({
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
      });
    }
    showToast(
      audioItems.length === 1
        ? translate('startedAudioDownload', resolvedLangRef.current)
        : translate('startedAudioDownloads', resolvedLangRef.current, { count: audioItems.length }),
      'success'
    );
    setTab('library');
  }, [allVideos, enqueue, showToast]);

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

  const videoCount  = allVideos.length;
  const mediaCount  = allVideos.length;
  const activeCount = active.length;

  // ─────────────────────────────────────────────────────────
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <LinearGradient
        colors={t.bgGrad}
        style={s.root}
      >
        <SafeAreaView style={[s.flex, IS_ANDROID && { paddingTop: TOP_PAD }]}>
          <ExpoStatusBar style={isDark ? 'light' : 'dark'} />



        {/* ══════════════════════════════════════════════════ */}
        {/*  HOME TAB                                         */}
        {/* ══════════════════════════════════════════════════ */}
        {tab === 'home' && (
          <View style={s.flex}>
            <View style={s.homeLogoContainer}>
              <View style={[
                s.logoGlowWrap,
                {
                  backgroundColor: t.dark ? 'rgba(124, 58, 237, 0.25)' : 'rgba(245, 158, 11, 0.25)',
                  shadowColor: t.dark ? '#7C3AED' : '#F59E0B',
                }
              ]}>
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
                        const url = m[0].replace(/[.,;:!?)\]}>'"]+$/, '');
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
                <Pressable
                  android_ripple={{ color: 'rgba(255,255,255,0.15)', borderless: false }}
                  style={[s.primaryBtn, { backgroundColor: t.btn }, extracting && { opacity: 0.5 }]}
                  onPress={handleHomeDownload}
                  disabled={extracting}
                >
                  <Text style={[s.primaryBtnLabel, { color: t.btnTxt, fontSize: fs(16) }]}>
                    {extracting ? translate('finding', resolvedLanguage) : translate('download', resolvedLanguage)}
                  </Text>
                </Pressable>
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
                            {getSourceName(task.media.url)} · {Math.round(task.progress * 100)}%
                          </Text>
                          <Pressable onPress={() => cancel(task.id)} hitSlop={S.xs}>
                            <Ionicons name="close" size={18} color={t.ink2} />
                          </Pressable>
                        </View>
                        <View style={[s.progressTrack, { backgroundColor: t.card2, marginTop: S.xs }]}>
                          <View style={[s.progressFill, { backgroundColor: getPlatformColor(task.media.url),
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
                <Ionicons name="chevron-back" size={24} color={t.ink} />
              </Pressable>
              
              <Text style={[s.browserTitle, { color: t.ink }]}>
                {translate('browse', resolvedLanguage).toUpperCase()}
              </Text>
              
              <Pressable
                android_ripple={RIPPLE_BL}
                onPress={scanBrowserPage}
                hitSlop={S.sm}
                style={[
                  s.navRowBtn,
                  (videoCount > 0 || mseActive) && {
                    backgroundColor: 'rgba(168, 85, 247, 0.15)',
                    borderRadius: 18,
                  }
                ]}
              >
                <Ionicons
                  name="scan-outline"
                  size={22}
                  color={(videoCount > 0 || mseActive) ? '#A855F7' : t.ink}
                />
              </Pressable>
            </View>
            
            {/* Row 2 */}
            <View style={[s.addressFieldWrap, { backgroundColor: t.card2, borderColor: t.sep, borderWidth: 1 }, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
              <Ionicons name="search-outline" size={18} color={t.ink3} style={{ marginHorizontal: S.xs }} />
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
                <Ionicons name="refresh" size={18} color={t.ink2} />
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

            {(videoCount > 0 || mseActive) && (
              <Pressable android_ripple={RIPPLE} style={[s.floatingBadge, { backgroundColor: t.btn }]}
                onPress={() => setVideosOpen(true)}>
                <Text style={[s.floatingBadgeLabel, { color: t.btnTxt }]}>
                  {mediaCount > 0
                    ? (mediaCount === 1
                      ? translate('mediaItemFound', resolvedLanguage)
                      : translate('mediaItemsFound', resolvedLanguage, { count: mediaCount }))
                    : translate('streamDetected', resolvedLanguage)}
                </Text>
              </Pressable>
            )}

            {/* Floating bookmark FAB */}
            {loadedUrl !== 'about:blank' && (
              <Pressable
                android_ripple={{ color: 'rgba(255,255,255,0.2)', borderless: true }}
                style={[s.bmFab, {
                  backgroundColor: isSaved(loadedUrl, bookmarks) ? t.btn : t.card,
                  ...(IS_IOS
                    ? { shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }
                    : { elevation: 5 }),
                }]}
                onPress={() => toggleBM(loadedUrl, getPageTitle(loadedUrl))}
              >
                <Ionicons
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
                    const source = getSourceName(task.media.url);
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
                const source      = getSourceName(task.media.url);
                const quality     = getQuality(task.media.url, task.media.label);
                const resolution  = getMediaResolution(task.media);
                const size        = fileSizes[task.id];
                const isDone      = task.status === 'completed';
                const isFail      = task.status === 'failed';
                const isPlayable  = !!task.localPlaylistPath && getMediaKind(task.media) === 'video' && /\.(mp4|ts|mov|webm|m4v)$/i.test(task.localPlaylistPath);
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
                                  <Ionicons name="play" size={10} color="#000000" style={{ marginLeft: 2 }} />
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
                         : isFail ? (task.error ?? translate('failedError', resolvedLanguage, { error: '' }).replace(': ', '').replace('：', ''))
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
                              {isPlayable && (
                                <Pressable android_ripple={RIPPLE_BL}
                                  style={[s.outlineBtn, { borderColor: t.sep }]}
                                  onPress={() => setPlayingPath(task.localPlaylistPath!)}>
                                  <Text style={[s.outlineBtnLabel, { color: t.ink, fontSize: fs(12) }]}>{translate('play', resolvedLanguage)}</Text>
                                </Pressable>
                              )}
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
                            <Ionicons name="checkmark" size={16} color={t.green} />
                          </View>
                        ) : isFail ? (
                          <>
                            <View style={[s.statusCircle, { backgroundColor: t.redBg, borderColor: t.red, borderWidth: 1 }]}>
                              <Ionicons name="alert" size={16} color={t.red} />
                            </View>
                            <Pressable onPress={() => handleRetry(task)} style={s.retryTextBtn}>
                              <Text style={{ color: t.red, fontSize: 11, fontWeight: '600', marginTop: S.xs }}>
                                {translate('retry', resolvedLanguage)}
                              </Text>
                            </Pressable>
                          </>
                        ) : (
                          <View style={[s.statusCircle, { backgroundColor: t.card2, borderColor: t.sep, borderWidth: 1 }]}>
                            <Ionicons name="close" size={16} color={t.ink3} />
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
                  <LinearGradient
                    colors={['#F91A7F', '#B528BA', '#FF8A00']}
                    start={{ x: 0, y: 1 }}
                    end={{ x: 1, y: 0 }}
                    style={s.bmRowAvatar}
                  >
                    {avatarContent}
                  </LinearGradient>
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
                        <Ionicons name="trash-outline" size={20} color={t.red} />
                      </Pressable>
                    ) : (
                      <Ionicons name="chevron-forward" size={18} color={t.ink3} />
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
          let iconName: React.ComponentProps<typeof Ionicons>['name'];
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
                  <Ionicons name={iconName} size={22} color={t.glass.pillActiveTxt} />
                </View>
              ) : (
                <Ionicons name={iconName} size={22} color={t.ink2} />
              )}
            </Pressable>
          );
        })}
      </View>

      {/* ══════════════════════════════════════════════════ */}
      {/*  VIDEOS SHEET (from browser)                      */}
      {/* ══════════════════════════════════════════════════ */}
      <Modal visible={videosOpen} transparent animationType="slide"
        onRequestClose={() => { setVideosOpen(false); setPreviewItem(null); }}>
        <Pressable style={s.backdrop} onPress={() => { setVideosOpen(false); setPreviewItem(null); }} />
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
                  onPress={() => { setVideosOpen(false); setPreviewItem(null); }} hitSlop={S.sm}>
                  <Text style={[s.closeRoundLabel, { color: t.ink2 }]}>✕</Text>
                </Pressable>
              </View>

              <ScrollView contentContainerStyle={{ padding: S.md, paddingBottom: S.xl }}>
                {/* Source avatar */}
                <View style={s.previewAvatar}>
                  <View style={[s.previewAvatarCircle, { backgroundColor: t.card }]}>
                    <Text style={[s.previewAvatarText, { color: t.ink }]}>
                      {getInitial(getSourceName(previewItem.url))}
                    </Text>
                  </View>
                  <Text style={[s.previewSource, { color: t.ink, fontSize: fs(18) }]}>
                    {getSourceName(previewItem.url)}
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

                {previewItem.availableFormats && previewItem.availableFormats.length > 0 && (
                  <View style={{ marginTop: S.md }}>
                    <Text style={[s.sectionLabel, { color: t.ink2, fontSize: fs(11), marginBottom: S.xs, textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                      {translate('formats', resolvedLanguage)}
                    </Text>
                    {previewItem.availableFormats.slice(0, 8).map((format) => {
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
                  {mediaCount > 0
                    ? (mediaCount === 1 ? translate('mediaItemFound', resolvedLanguage) : translate('mediaItemsFound', resolvedLanguage, { count: mediaCount }))
                    : translate('media', resolvedLanguage)}
                </Text>
                <Pressable android_ripple={RIPPLE_BL}
                  style={[s.closeRound, { backgroundColor: t.card }]}
                  onPress={() => setVideosOpen(false)} hitSlop={S.sm}>
                  <Text style={[s.closeRoundLabel, { color: t.ink2 }]}>✕</Text>
                </Pressable>
              </View>

              {allVideos.length > 0 && (
                <View style={[s.bulkDownloadRow, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
                  <Pressable android_ripple={RIPPLE}
                    style={[s.secondaryBtn, s.bulkDownloadBtn, { borderColor: t.sep }]}
                    onPress={handleDownloadAllDetected}>
                    <Text style={[s.secondaryBtnLabel, { color: t.ink, fontSize: fs(13) }]}>
                      {translate('downloadAll', resolvedLanguage)}
                    </Text>
                  </Pressable>
                  {allVideos.some((item) => getMediaKind(item) !== 'image') && (
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
                {allVideos.length === 0 && !mseActive && (
                  <View style={s.center}>
                    <Text style={[s.emptyHomeText, { color: t.ink2, fontSize: fs(14), textAlign: 'center',
                      paddingVertical: S.xl }]}>
                      {translate('browseForMedia', resolvedLanguage)}
                    </Text>
                  </View>
                )}
                {allVideos.map((item) => {
                  const source  = getSourceName(item.url);
                  const quality = getQuality(item.url, item.label) || getMediaFormat(item);
                  const resolution = getMediaResolution(item);
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
                          {compactMediaDetails(quality, resolution)}
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
                  onSubmitEditing={() => { setVideosOpen(false); handleHomeDownload(); }}
                  editable={!extracting}
                />
                <Pressable android_ripple={RIPPLE}
                  style={[s.dlBtn, { backgroundColor: t.btn }, extracting && { opacity: 0.5 }]}
                  onPress={() => { setVideosOpen(false); handleHomeDownload(); }}
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
        {playingPath && <VideoPlayerModal path={playingPath} onClose={() => setPlayingPath(null)} language={resolvedLanguage} />}
        <Toast message={toast} />
      </SafeAreaView>
      </LinearGradient>
    </SafeAreaProvider>
  );
}

// ── Styles ────────────────────────────────────────────────────
const s = StyleSheet.create({
  root:   { flex: 1 },
  flex:   { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  sep:    { height: StyleSheet.hairlineWidth, marginVertical: S.md },

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
    borderRadius: 55,
    alignItems: 'center',
    justifyContent: 'center',
    shadowRadius: 20,
    shadowOpacity: 0.6,
    shadowOffset: { width: 0, height: 0 },
    elevation: 5,
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
    width: 36,
    height: 36,
    borderRadius: 18,
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
  floatingBadge: {
    position: 'absolute',
    bottom: 20,
    alignSelf: 'center',
    paddingHorizontal: S.md,
    paddingVertical: S.sm,
    borderRadius: 100,
    zIndex: 10,
    ...(IS_IOS
      ? { shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }
      : { elevation: 4 }),
  },
  floatingBadgeLabel: { fontSize: 13, fontWeight: '600' },

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

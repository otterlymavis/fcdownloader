import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
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
  isNetworkDownloadCandidate,
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
type Tab = 'home' | 'browser' | 'library' | 'bookmarks';

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
    setTheme,
    setFontSize,
    setLanguage,
  } = useSettings();
  const t = useTheme(theme === 'system' ? undefined : theme === 'dark');
  const isDark = t.dark;
  const fs = (base: number) => base * fontScale;
  const webviewRef = useRef<WebView>(null);

  const resolvedLangRef = useRef(resolvedLanguage);
  resolvedLangRef.current = resolvedLanguage;

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

  // ── Core hooks ────────────────────────────────────────────
  const { detected, networkLog, mseActive, onPageChange, onMessage, addDetected } = useMediaDetection();
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

  const handleIncomingUrl = useCallback((raw: string) => {
    try {
      const parsed = Linking.parse(raw);
      if (parsed.path === 'share' || parsed.hostname === 'share') {
        const mediaUrl = parsed.queryParams?.url ? String(parsed.queryParams.url) : null;
        if (mediaUrl) { setPasteUrl(mediaUrl); setTab('home'); showToast(translate('linkReceived', resolvedLangRef.current), 'success'); }
      }
    } catch {}
  }, [showToast]);

  useEffect(() => {
    Linking.getInitialURL().then((url) => { if (url) handleIncomingUrl(url); });
    const sub = Linking.addEventListener('url', ({ url }) => handleIncomingUrl(url));
    return () => sub.remove();
  }, [handleIncomingUrl]);

  // ── Download manager ──────────────────────────────────────
  const { active, history, enqueue, retry, cancel, remove } = useDownloadManager({
    onComplete: useCallback(() => showToast(translate('downloadComplete', resolvedLangRef.current), 'success'), [showToast]),
    onError:    useCallback((task: DownloadTask) =>
      showToast(translate('failedError', resolvedLangRef.current, { error: task.error ?? 'unknown error' }), 'error'), [showToast]),
  });

  // ── Detected videos ───────────────────────────────────────
  const allVideos = useMemo<DetectedMedia[]>(() => {
    const seen = new Set(detected.map((m) => m.url));
    const fromNet: DetectedMedia[] = networkLog
      .filter((url) => isNetworkDownloadCandidate(url) && !seen.has(url))
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

  // ── Home: paste → download ────────────────────────────────
  const handleHomeDownload = useCallback(async () => {
    let url = pasteUrl.trim();
    if (!url || extracting) return;
    if (!url.startsWith('http')) url = `https://${url}`;

    if (isDirectMediaUrl(url)) {
      const item: DetectedMedia = {
        id: `home_${Date.now()}`, url, pageUrl: url, userAgent: '',
        timestamp: Date.now(),
        mediaType: guessMediaType(url),
        mediaKind: getMediaKind({ url }),
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
      const items = await extractionManager.extractMedia(url);
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
    setLoadedUrl(url); setBrowserInput(url); setTab('browser');
  }, [pasteUrl, extracting, enqueue, showToast]);

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
    <View style={[s.root, { backgroundColor: t.bg, paddingTop: TOP_PAD }]}>
      <ExpoStatusBar style={isDark ? 'light' : 'dark'} />

      {/* ══════════════════════════════════════════════════ */}
      {/*  HOME TAB                                         */}
      {/* ══════════════════════════════════════════════════ */}
      {tab === 'home' && (
        <View style={s.flex}>
          <View style={[s.topBar, { backgroundColor: t.bg, borderBottomColor: t.sep }]}>
            {IS_IOS
              ? <Text style={[s.largeTitleIOS, { color: t.ink, textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>{translate('downloader', resolvedLanguage)}</Text>
              : <Text style={[s.titleAndroid, { color: t.ink, textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>{translate('downloader', resolvedLanguage)}</Text>
            }
            <Pressable android_ripple={RIPPLE_BL} style={[s.gearBtn, { backgroundColor: t.card }]}
              onPress={() => setSettingsOpen(true)} hitSlop={S.sm}>
              <Text style={[s.gearIcon, { color: t.ink2 }]}>⚙</Text>
            </Pressable>
          </View>

          <ScrollView
            style={s.flex}
            contentContainerStyle={[s.homeScroll, { paddingBottom: BOTTOM_PAD + 80 }]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Paste card */}
            <View style={[s.pasteCard, { backgroundColor: t.bg }, subtleShadow,
              IS_ANDROID && { backgroundColor: t.card }]}>
              <Text style={[s.pasteLabel, { color: t.ink2, fontSize: fs(12), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                {translate('videoOrPageLink', resolvedLanguage)}
              </Text>
              <TextInput
                style={[s.pasteInput, { backgroundColor: t.card, color: t.ink, fontSize: fs(15),
                  textAlign: resolvedLanguage === 'ar' ? 'right' : 'left',
                  ...(IS_ANDROID && { backgroundColor: t.card2 }) }]}
                value={pasteUrl}
                onChangeText={(text) => {
                  // Auto-extract first http(s) URL when the change looks like
                  // a paste (large delta) and the result contains noise
                  // around a URL — common with share-sheet output like
                  // "Watch this: https://… via @user". Manual typing changes
                  // 1-2 chars at a time so this never disrupts editing.
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
                placeholder={translate('pastePlaceholder', resolvedLanguage)}
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
                <Text style={[s.browseLinkLabel, { color: t.ink2, fontSize: fs(13), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                  {translate('orBrowse', resolvedLanguage)}
                </Text>
              </Pressable>
              <Text style={[s.browseHint, { color: t.ink3, fontSize: fs(11), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                {translate('browseHint', resolvedLanguage)}
              </Text>

              <Pressable
                android_ripple={{ color: 'rgba(255,255,255,0.15)', borderless: false }}
                style={[s.outlineBtn, { borderColor: t.sep, marginTop: 16 }]}
                onPress={async () => {
                  try {
                    showToast(translate('installingTools', resolvedLangRef.current), 'info');
                    const res = await fetch('http://127.0.0.1:8765/tools/ensure', { method: 'POST' });
                    if (res.ok) {
                      showToast(translate('toolsUpdated', resolvedLangRef.current), 'success');
                    } else {
                      showToast(translate('toolsUpdateFailed', resolvedLangRef.current), 'error');
                    }
                  } catch (e) {
                    showToast(translate('companionNotRunning', resolvedLangRef.current), 'error');
                  }
                }}
              >
                <Text style={[s.outlineBtnLabel, { color: t.ink2, fontSize: fs(13) }]}>
                  {translate('installUpdateTools', resolvedLanguage)}
                </Text>
              </Pressable>
            </View>

            {/* Active downloads (compact) */}
            {active.length > 0 && (
              <View style={s.section}>
                <Text style={[s.sectionLabel, { color: t.ink2, fontSize: fs(11), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                  {translate('inProgress', resolvedLanguage).toUpperCase()}
                </Text>
                {active.map((task) => {
                  const resolution = getMediaResolution(task.media);
                  const statusText = task.status === 'downloading' && task.totalSegments > 0
                    ? translate('parts', resolvedLanguage, { downloaded: task.downloadedSegments, total: task.totalSegments })
                    : task.status === 'assembling'        ? translate('assembling', resolvedLanguage)
                    : task.status === 'fetching_manifest' ? translate('readingStream', resolvedLanguage)
                    : translate('starting', resolvedLanguage);
                  return (
                  <View key={task.id} style={[s.compactCard, { backgroundColor: t.card }, subtleShadow]}>
                    <View style={s.compactRow}>
                      <Text style={[s.compactSource, { color: t.ink, fontSize: fs(14), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                        {getSourceName(task.media.url)}
                      </Text>
                      <Text style={[s.compactPct, { color: t.ink2, fontSize: fs(13) }]}>
                        {Math.round(task.progress * 100)}%
                      </Text>
                      <Pressable android_ripple={RIPPLE_BL} onPress={() => cancel(task.id)} hitSlop={S.xs}
                        style={[s.cancelBtn, { borderColor: t.sep }]}>
                        <Text style={[s.cancelBtnLabel, { color: t.ink2, fontSize: fs(12) }]}>{translate('cancel', resolvedLanguage)}</Text>
                      </Pressable>
                    </View>
                    <View style={[s.progressTrack, { backgroundColor: t.card2 }]}>
                      <View style={[s.progressFill, { backgroundColor: t.btn,
                        width: `${Math.round(task.progress * 100)}%` as `${number}%` }]} />
                    </View>
                    <Text style={[s.compactStatus, { color: t.ink2, fontSize: fs(11), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                      {compactMediaDetails(statusText, resolution)}
                    </Text>
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
          <View style={[s.navBar, { backgroundColor: t.bg, borderBottomColor: t.sep }]}>
            <TextInput
              style={[s.addressField, { backgroundColor: t.card, color: t.ink, fontSize: fs(14),
                textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}
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
            <Pressable android_ripple={RIPPLE_BL} style={[s.navBtn, { backgroundColor: t.card }]}
              onPress={() => webviewRef.current?.reload()} hitSlop={S.sm}>
              <Text style={[s.navBtnIcon, { color: t.ink }]}>↻</Text>
            </Pressable>
            <Pressable android_ripple={RIPPLE_BL} style={[s.navBtn, { backgroundColor: t.card }]}
              onPress={scanBrowserPage} hitSlop={S.sm}>
              <Text style={[s.navBtnIcon, { color: t.ink }]}>◉</Text>
            </Pressable>
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
                <Text style={[s.bmFabIcon, { color: isSaved(loadedUrl, bookmarks) ? t.btnTxt : t.ink2 }]}>
                  {isSaved(loadedUrl, bookmarks) ? '★' : '☆'}
                </Text>
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
                    <Text style={[{ color: t.ink2, fontSize: fs(14) }]}>{translate('select', resolvedLanguage)}</Text>
                  </Pressable>
                )}
              </>
            )}
          </View>

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
              {active.length > 0 && (
                <>
                  <Text style={[s.sectionLabel, { color: t.ink2, fontSize: fs(11), marginBottom: S.sm, textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                    {translate('inProgress', resolvedLanguage).toUpperCase()}
                  </Text>
                  {active.map((task) => {
                    const resolution = getMediaResolution(task.media);
                    const statusText = task.status === 'downloading' && task.totalSegments > 0
                      ? translate('parts', resolvedLanguage, { downloaded: task.downloadedSegments, total: task.totalSegments })
                      : task.status === 'assembling'        ? translate('assembling', resolvedLanguage)
                      : task.status === 'fetching_manifest' ? translate('readingStream', resolvedLanguage)
                      : translate('starting', resolvedLanguage);
                    return (
                    <View key={task.id} style={[s.libraryCard, { backgroundColor: t.card }, subtleShadow]}>
                      <View style={s.libraryCardLeft}>
                        <View style={[s.sourceAvatar, { backgroundColor: t.card2 }]}>
                          <Text style={[s.sourceAvatarText, { color: t.ink, fontSize: fs(18) }]}>
                            {getInitial(getSourceName(task.media.url))}
                          </Text>
                        </View>
                      </View>
                      <View style={s.libraryCardBody}>
                        <View style={s.libraryCardRow}>
                          <Text style={[s.libraryCardTitle, { color: t.ink, fontSize: fs(14), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                            {getSourceName(task.media.url)}
                          </Text>
                          <Text style={[s.libraryCardPct, { color: t.ink2, fontSize: fs(13) }]}>
                            {Math.round(task.progress * 100)}%
                          </Text>
                        </View>
                        <View style={[s.progressTrack, { backgroundColor: t.card2, marginVertical: S.xs }]}>
                          <View style={[s.progressFill, { backgroundColor: t.btn,
                            width: `${Math.round(task.progress * 100)}%` as `${number}%` }]} />
                        </View>
                        <Text style={[s.libraryCardSub, { color: t.ink2, fontSize: fs(11), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                          {compactMediaDetails(statusText, resolution)}
                        </Text>
                        <Pressable android_ripple={RIPPLE_BL} onPress={() => cancel(task.id)}
                          style={[s.outlineBtn, { borderColor: t.sep, marginTop: S.xs }]}>
                          <Text style={[s.outlineBtnLabel, { color: t.ink2, fontSize: fs(12) }]}>{translate('cancel', resolvedLanguage)}</Text>
                        </Pressable>
                      </View>
                    </View>
                    );
                  })}
                  {history.length > 0 && <View style={[s.sep, { backgroundColor: t.sep }]} />}
                </>
              )}

              {/* Completed / failed / cancelled */}
              {history.length > 0 && active.length > 0 && (
                <Text style={[s.sectionLabel, { color: t.ink2, fontSize: fs(11), marginBottom: S.sm, textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
                  {translate('completed', resolvedLanguage).toUpperCase()}
                </Text>
              )}
              {history.map((task) => {
                const source      = getSourceName(task.media.url);
                const quality     = getQuality(task.media.url, task.media.label);
                const resolution  = getMediaResolution(task.media);
                const size        = fileSizes[task.id];
                const isDone      = task.status === 'completed';
                const isFail      = task.status === 'failed';
                const isPlayable  = !!task.localPlaylistPath && getMediaKind(task.media) === 'video' && /\.(mp4|ts|mov|webm|m4v)$/i.test(task.localPlaylistPath);
                const canSaveToLibrary = !!task.localPlaylistPath && getMediaKind(task.media) !== 'audio';
                const isSelected  = libSelected.has(task.id);

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
                        <View style={[s.sourceAvatar,
                          { backgroundColor: isDone ? t.card2 : isFail ? t.redBg : t.card2 }]}>
                          <Text style={[s.sourceAvatarText,
                            { color: isFail ? t.red : t.ink, fontSize: fs(18) }]}>
                            {getInitial(source)}
                          </Text>
                        </View>
                      )}
                    </View>
                    <View style={s.libraryCardBody}>
                      <View style={s.libraryCardRow}>
                        <Text style={[s.libraryCardTitle, { color: t.ink, fontSize: fs(14), textAlign: resolvedLanguage === 'ar' ? 'right' : 'left' }]}>
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
              <Text style={[s.topBarCount, { color: t.ink2, fontSize: fs(13) }]}>
                {bookmarks.length}
              </Text>
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
                return (
                  <Pressable key={bm.id} android_ripple={RIPPLE}
                    style={[s.bmRow, { backgroundColor: t.card }, subtleShadow]}
                    onPress={() => { setLoadedUrl(bm.url); setBrowserInput(bm.url); setTab('browser'); }}
                    onLongPress={() => Alert.alert(translate('removeBookmark', resolvedLangRef.current), translate('removeBookmarkConfirm', resolvedLangRef.current, { title: bm.title || domain }), [
                      { text: translate('cancel', resolvedLangRef.current), style: 'cancel' },
                      { text: translate('remove', resolvedLangRef.current), style: 'destructive', onPress: () => removeBM(bm.id) },
                    ])}>
                    <View style={[s.bmRowAvatar, { backgroundColor: t.card2 }]}>
                      <Text style={[s.bmRowAvatarText, { color: t.ink, fontSize: fs(16) }]}>
                        {getInitial(bm.title || domain)}
                      </Text>
                    </View>
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
                    <Text style={[s.bmRowChevron, { color: t.ink3 }]}>›</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </View>
      )}

      {/* ── Tab bar ─────────────────────────────────────── */}
      <View style={[s.tabBar, { backgroundColor: t.bg, borderTopColor: t.sep, paddingBottom: BOTTOM_PAD }, resolvedLanguage === 'ar' && { flexDirection: 'row-reverse' }]}>
        {(['home', 'browser', 'library', 'bookmarks'] as Tab[]).map((id, idx) => {
          const transKey: TranslationKey = id === 'bookmarks' ? 'saved' : id as TranslationKey;
          const translatedLabel = translate(transKey, resolvedLanguage);
          const countSuffix = id === 'home' && activeCount > 0 ? `  ${activeCount}`
            : id === 'browser' && mediaCount > 0 ? `  ${mediaCount}`
            : id === 'library' && allTasks.length > 0 ? `  ${allTasks.length}`
            : id === 'bookmarks' && bookmarks.length > 0 ? `  ${bookmarks.length}`
            : '';
          const labelText = `${translatedLabel}${countSuffix}`;
          const isActive = tab === id;
          return (
            <React.Fragment key={id}>
              {idx > 0 && <View style={[s.tabSep, { backgroundColor: t.sep }]} />}
              <Pressable android_ripple={RIPPLE} style={s.tabItem} onPress={() => setTab(id)}>
                {IS_ANDROID && isActive && <View style={[s.tabPill, { backgroundColor: `${t.btn}12` }]} />}
                <Text style={[s.tabLabel, { color: isActive ? t.ink : t.ink2,
                  fontWeight: isActive ? '600' : '400', fontSize: fs(13) }]}>
                  {labelText}
                </Text>
                {IS_IOS && isActive && <View style={[s.tabDot, { backgroundColor: t.ink }]} />}
              </Pressable>
            </React.Fragment>
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
      <SettingsSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)}
        theme={theme} fontSize={fontSize} language={language}
        onThemeChange={setTheme} onFontSizeChange={setFontSize} onLanguageChange={setLanguage}
        resolvedLanguage={resolvedLanguage} t={t} />
      {playingPath && <VideoPlayerModal path={playingPath} onClose={() => setPlayingPath(null)} language={resolvedLanguage} />}
      <Toast message={toast} />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────
const s = StyleSheet.create({
  root:   { flex: 1 },
  flex:   { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  sep:    { height: StyleSheet.hairlineWidth, marginVertical: S.md },

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

  pasteCard: {
    borderRadius: R.lg,
    padding: S.md,
    gap: S.sm,
    ...(IS_IOS ? {} : {}),
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
    borderRadius: R.md,
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

  compactCard: {
    borderRadius: R.md,
    padding: S.md,
    gap: S.xs,
  },
  compactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.sm,
  },
  compactSource: { flex: 1, fontWeight: '500' },
  compactPct:    { fontWeight: '400' },
  cancelBtn: {
    height: 28,
    paddingHorizontal: S.sm,
    borderRadius: R.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnLabel: { fontWeight: '400' },
  compactStatus:  { fontWeight: '400' },

  progressTrack: { height: 3, borderRadius: 2, overflow: 'hidden' },
  progressFill:  { height: 3, borderRadius: 2 },

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
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.md,
    paddingVertical: S.sm,
    gap: S.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  addressField: {
    flex: 1,
    height: 40,
    borderRadius: R.md,
    paddingHorizontal: S.md,
  },
  navBtn: {
    width: 40,
    height: 40,
    borderRadius: R.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navBtnIcon: { fontSize: 18, lineHeight: 22 },


  floatingBadge: {
    position: 'absolute',
    top: S.md,
    alignSelf: 'center',
    paddingHorizontal: S.md,
    paddingVertical: S.sm,
    borderRadius: 100,
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
  libraryCardBody: { flex: 1, gap: S.xs },
  libraryCardRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  libraryCardTitle: { flex: 1, fontWeight: '600' },
  libraryCardPct:   { fontWeight: '400' },
  libraryCardSub:   { fontWeight: '400' },
  libraryActions: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, marginTop: S.xs },
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
    flexDirection: 'row',
    height: 52,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tabPill: {
    position: 'absolute',
    height: 32,
    borderRadius: 16,
    width: '80%',
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
    bottom: S.lg,
    right: S.lg,
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
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

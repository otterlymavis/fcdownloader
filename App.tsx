import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Clipboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import WebView from 'react-native-webview';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';

import BrowserView from './src/components/BrowserView';
import DownloadProgressBar from './src/components/DownloadProgressBar';
import Toast, { ToastMessage } from './src/components/Toast';
import VideoPlayerModal from './src/components/VideoPlayerModal';

import { useMediaDetection } from './src/hooks/useMediaDetection';
import { useDownloadManager } from './src/hooks/useDownloadManager';
import { useBookmarks } from './src/hooks/useBookmarks';
import { DetectedMedia, DownloadStrategy, DownloadTask } from './src/types';
import { extractFromSocialUrl, isSocialPageUrl } from './src/lib/platformExtractors';

// ── Constants ─────────────────────────────────────────────────
const TOP_PAD    = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 0;
const BOTTOM_PAD = Platform.OS === 'android' ? 16 : 0;
const IS_IOS     = Platform.OS === 'ios';
const IS_ANDROID = Platform.OS === 'android';

// Material ripple config (Android only)
const RIPPLE      = IS_ANDROID ? { color: 'rgba(0,0,0,0.12)', borderless: false } : undefined;
const RIPPLE_DARK = IS_ANDROID ? { color: 'rgba(255,255,255,0.12)', borderless: false } : undefined;
const RIPPLE_BL   = IS_ANDROID ? { color: 'rgba(0,0,0,0.12)', borderless: true  } : undefined;

// 60-30-10 accent colors (10%)
const BLUE   = '#007AFF';
const GREEN  = '#34C759';
const RED    = '#FF3B30';
const ORANGE = '#FF9500';
const PURPLE = '#AF52DE';

// Spacing scale — 8px base, only multiples used throughout
const S = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

// Border radii
const R = { sm: 8, md: 12, lg: 14, sheet: 20 } as const;

// ── Theme ─────────────────────────────────────────────────────
function useTheme() {
  const dark = useColorScheme() === 'dark';
  // Material Design 3 surface tones on Android, Apple HIG on iOS
  const pageBg  = IS_ANDROID
    ? (dark ? '#1A1C1E' : '#F8F9FA')
    : (dark ? '#000000' : '#F2F2F7');
  const surface = IS_ANDROID
    ? (dark ? '#25282B' : '#FFFFFF')
    : (dark ? '#1C1C1E' : '#FFFFFF');
  const surface2 = IS_ANDROID
    ? (dark ? '#2F3234' : '#EAECEF')
    : (dark ? '#2C2C2E' : '#F2F2F7');
  const inputBg = IS_ANDROID
    ? (dark ? '#2F3234' : '#EAECEF')
    : (dark ? '#2C2C2E' : '#F0F0F5');
  return {
    dark,
    pageBg,
    surface,
    surface2,
    inputBg,
    label:  dark ? '#FFFFFF' : '#000000',
    label2: dark ? '#8E8E93' : '#6E6E73',
    label3: dark ? '#48484A' : '#C7C7CC',
    sep:    dark ? '#38383A' : '#E5E5EA',
    ripple: dark ? RIPPLE_DARK : RIPPLE,
  } as const;
}

// ── Helpers ───────────────────────────────────────────────────
function getSourceName(url: string): string {
  if (/video\.twimg\.com|twimg\.com/i.test(url))                          return 'Twitter';
  if (/cdninstagram\.com|instagram\.com/i.test(url))                      return 'Instagram';
  if (/threads\.net/i.test(url))                                           return 'Threads';
  if (/vimeocdn\.com|vimeo\.com/i.test(url))                              return 'Vimeo';
  if (/tiktokcdn\.com|tiktokcdn-us\.com|v\d+-webapp\.tiktok\.com|tiktok\.com/i.test(url)) return 'TikTok';
  if (/v\.redd\.it|reddit\.com/i.test(url))                               return 'Reddit';
  if (/googlevideo\.com|youtube\.com/i.test(url))                         return 'YouTube';
  if (/dailymotion\.com|dmcdn\.net/i.test(url))                           return 'Dailymotion';
  if (/facebook\.com|fbcdn\.net/i.test(url))                              return 'Facebook';
  if (/twitch\.tv|usher\.twitch\.tv/i.test(url))                          return 'Twitch';
  if (/pinimg\.com|pinterest\.com/i.test(url))                            return 'Pinterest';
  if (/mdpr\.jp|modelpress\.jp/i.test(url))                               return 'Modelpress';
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const name = host.split('.').slice(-2, -1)[0] ?? 'Video';
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch { return 'Video'; }
}

function getQuality(url: string): string | null {
  // YouTube MIME quality param e.g. &quality=hd720 or &height=1080
  const ytH = url.match(/[?&]height=(\d+)/i);
  if (ytH) {
    const h = parseInt(ytH[1], 10);
    if (h >= 2160) return '4K';
    if (h >= 1080) return '1080p';
    if (h >= 720)  return '720p';
    if (h >= 480)  return '480p';
    if (h >= 360)  return '360p';
  }
  const ytQ = url.match(/[?&]quality(?:_label)?=([^&]+)/i);
  if (ytQ) {
    const q = ytQ[1].toLowerCase();
    if (q.includes('2160') || q.includes('4k')) return '4K';
    if (q.includes('1080')) return '1080p';
    if (q.includes('720'))  return '720p';
    if (q.includes('480'))  return '480p';
    if (q.includes('360'))  return '360p';
  }
  if (/4k|2160/i.test(url)) return '4K';
  if (/1080/i.test(url))    return '1080p';
  if (/720/i.test(url))     return '720p';
  if (/480/i.test(url))     return '480p';
  if (/360/i.test(url))     return '360p';
  if (/\bhd\b/i.test(url))  return 'HD';
  return null;
}

function getFormatLabel(url: string): string {
  const u = url.toLowerCase();
  if (u.includes('.m3u8'))                return 'HLS Stream';
  if (u.includes('.mpd'))                 return 'DASH Stream';
  if (u.includes('playlist.json'))        return 'Vimeo';
  if (/\.(mp4|m4v)/.test(u))             return 'MP4';
  if (u.includes('.webm'))                return 'WebM';
  if (u.includes('googlevideo.com'))      return 'MP4';
  if (u.includes('video.twimg.com'))      return 'MP4';
  if (u.includes('cdninstagram.com'))     return 'MP4';
  if (u.includes('tiktokcdn.com'))        return 'MP4';
  if (u.includes('tiktokcdn-us.com'))     return 'MP4';
  if (/v\d+-webapp\.tiktok\.com/.test(u)) return 'MP4';
  if (u.includes('v.redd.it'))            return 'MP4';
  if (u.includes('pinimg.com'))           return 'MP4';
  if (u.includes('dmcdn.net'))            return 'HLS Stream';
  if (u.includes('usher.twitch.tv'))      return 'HLS Stream';
  return 'Video';
}

function getPageTitle(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url.slice(0, 40); }
}

function formatBytes(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

const SEGMENT_RE    = /\.(ts|m4s|aac|m4a|cmfv|cmfa)(\?|#|$)/i;
const VIMEO_RANGE_RE = /vimeocdn\.com\/.*\/v2\/range\/.*\/avf\//i;
const USEFUL_EXT_RE  = /\.(m3u8|mpd|mp4|m4v|webm|mov)(\?|#|$)/i;
const VIMEO_JSON_RE  = /vimeocdn\.com\/.*\/playlist\.json(\?|$)/i;
const VIDEO_CDN_RE   = /(?:googlevideo\.com\/videoplayback|video\.twimg\.com\/|cdninstagram\.com\/|scontent[-\w]*\.cdninstagram\.com\/|tiktokcdn\.com\/|tiktokcdn-us\.com\/|v\d+-webapp\.tiktok\.com\/|v\.redd\.it\/|fbcdn\.net\/videos|pinimg\.com\/videos\/|dmcdn\.net\/|usher\.twitch\.tv\/)/i;

function isUseful(url: string): boolean {
  const clean = url.split('#')[0];
  if (SEGMENT_RE.test(clean))   return false;
  if (VIMEO_RANGE_RE.test(url)) return false;
  return USEFUL_EXT_RE.test(url) || VIMEO_JSON_RE.test(url) || VIDEO_CDN_RE.test(url);
}

// ── Card shadow (iOS native shadow, Android elevation) ─────────
const cardShadow = IS_IOS
  ? { shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } }
  : { elevation: 1 };  // Material Design tonal elevation level 1

// ─────────────────────────────────────────────────────────────
export default function App() {
  const t = useTheme();
  const webviewRef = useRef<WebView>(null);

  const [inputUrl, setInputUrl]           = useState('');
  const [loadedUrl, setLoadedUrl]         = useState('https://www.google.com');
  const [videosOpen, setVideosOpen]       = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [playingPath, setPlayingPath]     = useState<string | null>(null);
  const [toast, setToast]                 = useState<ToastMessage | null>(null);
  const [manualUrl, setManualUrl]         = useState('');
  const [fileSizes, setFileSizes]         = useState<Record<string, string>>({});
  const [videosSelectMode, setVideosSelectMode]       = useState(false);
  const [selectedVideoIds, setSelectedVideoIds]       = useState<Set<string>>(new Set());
  const [downloadsSelectMode, setDownloadsSelectMode] = useState(false);
  const [selectedDlIds, setSelectedDlIds]             = useState<Set<string>>(new Set());
  const [extracting, setExtracting]                   = useState(false);

  const { detected, networkLog, mseActive, onPageChange, onMessage, addDetected } = useMediaDetection();
  const { bookmarks, toggle: toggleBM, remove: removeBM, isSaved } = useBookmarks();

  const showToast = useCallback((msg: string, type: ToastMessage['type'] = 'info') => {
    setToast({ id: String(Date.now()), text: msg, type });
  }, []);

  const { active, history, enqueue, retry, cancel, remove } = useDownloadManager({
    onComplete: useCallback(() => showToast('Download complete', 'success'), [showToast]),
    onError:    useCallback((task: DownloadTask) =>
      showToast(`Failed: ${task.error ?? 'unknown error'}`, 'error'), [showToast]),
  });

  // Merge auto-detected + useful network URLs, deduplicated
  const allVideos = useMemo<DetectedMedia[]>(() => {
    const seen = new Set(detected.map((m) => m.url));
    const fromNet: DetectedMedia[] = networkLog
      .filter((url) => isUseful(url) && !seen.has(url))
      .map((url) => ({
        id: `net_${url}`,
        url,
        pageUrl: loadedUrl,
        userAgent: '',
        timestamp: Date.now(),
        mediaType: url.toLowerCase().includes('.mpd') ? 'dash' : 'hls',
      }));
    return [...detected, ...fromNet];
  }, [detected, networkLog, loadedUrl]);

  const allTasks = useMemo(() => [...active, ...history], [active, history]);
  const deletableTasks = useMemo(
    () => allTasks.filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'),
    [allTasks],
  );

  // Read file sizes when Downloads panel opens
  useEffect(() => {
    if (!downloadsOpen) return;
    history.forEach(async (task) => {
      if (task.status !== 'completed' || !task.localPlaylistPath || fileSizes[task.id]) return;
      try {
        const info = await FileSystem.getInfoAsync(task.localPlaylistPath);
        if (info.exists && (info as { size?: number }).size) {
          setFileSizes((p) => ({ ...p, [task.id]: formatBytes((info as { size: number }).size) }));
        }
      } catch {}
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadsOpen, history.length]);

  // ── Navigation ────────────────────────────────────────────────
  const navigate = useCallback(() => {
    let url = inputUrl.trim();
    if (!url) return;
    if (!url.startsWith('http')) url = `https://${url}`;
    if (url === loadedUrl) webviewRef.current?.reload();
    else setLoadedUrl(url);
  }, [inputUrl, loadedUrl]);

  const handleAddManual = useCallback(async () => {
    const url = manualUrl.trim();
    if (!url || extracting) return;

    // If it looks like a social-media post page URL, extract the video URL from it
    if (isSocialPageUrl(url)) {
      setExtracting(true);
      try {
        const items = await extractFromSocialUrl(url);
        if (items.length > 0) {
          let added = 0;
          items.forEach((item) => { if (addDetected(item.url, item.pageUrl)) added++; });
          setManualUrl('');
          showToast(added > 0 ? `Found ${added} video${added !== 1 ? 's' : ''}` : 'No videos found', added > 0 ? 'success' : 'error');
        } else {
          showToast('No videos found on that page', 'error');
        }
      } catch {
        showToast('Extraction failed — try browsing to the page', 'error');
      } finally {
        setExtracting(false);
      }
      return;
    }

    // Direct video URL
    if (addDetected(url)) { setManualUrl(''); showToast('Video added', 'success'); }
    else showToast('Not a valid video URL', 'error');
  }, [manualUrl, extracting, addDetected, showToast]);

  const handleDownload = useCallback(async (item: DetectedMedia) => {
    setVideosOpen(false);
    showToast('Download started', 'info');
    await enqueue(item);
  }, [enqueue, showToast]);

  const handleExport = useCallback(async (task: DownloadTask) => {
    if (!task.localPlaylistPath) return;
    try {
      if (!(await Sharing.isAvailableAsync())) { showToast('Sharing not available', 'error'); return; }
      const path = task.localPlaylistPath;
      const mime = path.endsWith('.mp4')  ? 'video/mp4'
                 : path.endsWith('.ts')   ? 'video/mp2t'
                 : path.endsWith('.webm') ? 'video/webm'
                 : 'application/octet-stream';
      await Sharing.shareAsync(path, { mimeType: mime, dialogTitle: 'Export video' });
    } catch (e) { showToast(`Export failed: ${(e as Error).message}`, 'error'); }
  }, [showToast]);

  const handleGallery = useCallback(async (task: DownloadTask) => {
    if (!task.localPlaylistPath) return;
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status !== 'granted') { showToast('Gallery permission denied', 'error'); return; }
    try {
      await MediaLibrary.saveToLibraryAsync(task.localPlaylistPath);
      showToast('Saved to gallery', 'success');
    } catch (e) { showToast(`Gallery save failed: ${(e as Error).message}`, 'error'); }
  }, [showToast]);

  const handleRetry = useCallback((task: DownloadTask) => {
    const strategies: { key: DownloadStrategy; label: string }[] = [
      { key: 'hls-segments', label: 'Stream (HLS segments)' },
      { key: 'direct',       label: 'Direct file download'  },
      { key: 'vimeo-json',   label: 'Vimeo format'          },
    ];
    Alert.alert('Retry', 'Choose download method:', [
      ...strategies.map(({ key, label }) => ({
        text: label + (key === task.strategy ? ' — used last time' : ''),
        onPress: () => retry(task.id, key),
      })),
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [retry]);

  const toggleVideoSelect = useCallback((id: string) => {
    setSelectedVideoIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleDlSelect = useCallback((id: string) => {
    setSelectedDlIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleDownloadSelected = useCallback(async () => {
    const items = allVideos.filter((v) => selectedVideoIds.has(v.id));
    if (!items.length) return;
    setVideosOpen(false);
    setVideosSelectMode(false);
    setSelectedVideoIds(new Set());
    showToast(`Downloading ${items.length} video${items.length !== 1 ? 's' : ''}`, 'info');
    for (const item of items) await enqueue(item);
  }, [allVideos, selectedVideoIds, enqueue, showToast]);

  const handleDeleteSelected = useCallback(() => {
    const ids = [...selectedDlIds];
    if (!ids.length) return;
    Alert.alert(
      'Delete Downloads',
      `Delete ${ids.length} download${ids.length !== 1 ? 's' : ''}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => {
          ids.forEach((id) => remove(id));
          setSelectedDlIds(new Set());
          setDownloadsSelectMode(false);
        }},
      ],
    );
  }, [selectedDlIds, remove]);

  const videoCount    = allVideos.length;
  const downloadCount = history.length + active.length;

  return (
    <View style={[s.root, { backgroundColor: t.pageBg, paddingTop: TOP_PAD, paddingBottom: BOTTOM_PAD }]}>
      <ExpoStatusBar style={t.dark ? 'light' : 'dark'} />

      {/* ── Navigation bar ───────────────────────────────────── */}
      <View style={[s.navBar, { backgroundColor: t.surface, borderBottomColor: t.sep }]}>
        <TextInput
          style={[s.addressField, { backgroundColor: t.inputBg, color: t.label }]}
          value={inputUrl}
          onChangeText={setInputUrl}
          onSubmitEditing={navigate}
          placeholder="Search or enter website"
          placeholderTextColor={t.label3}
          returnKeyType="go"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          selectTextOnFocus
        />
        <Pressable android_ripple={RIPPLE} style={s.goButton} onPress={navigate} hitSlop={S.sm}>
          <Text style={s.goButtonLabel}>Go</Text>
        </Pressable>
        <Pressable
          android_ripple={RIPPLE_BL}
          style={[s.iconButton, { backgroundColor: t.inputBg }]}
          onPress={() => webviewRef.current?.reload()}
          hitSlop={S.sm}
        >
          <Text style={[s.iconButtonLabel, { color: t.label }]}>↻</Text>
        </Pressable>
        <Pressable
          android_ripple={RIPPLE_BL}
          style={[s.iconButton, { backgroundColor: t.inputBg }]}
          onPress={() => toggleBM(loadedUrl, getPageTitle(loadedUrl))}
          hitSlop={S.sm}
        >
          <Text style={[s.iconButtonLabel, { color: isSaved(loadedUrl, bookmarks) ? BLUE : t.label2 }]}>
            {isSaved(loadedUrl, bookmarks) ? '★' : '☆'}
          </Text>
        </Pressable>
      </View>

      {/* ── Bookmark strip ────────────────────────────────────── */}
      {bookmarks.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[s.bmBar, { backgroundColor: t.surface, borderBottomColor: t.sep }]}
          contentContainerStyle={s.bmContent}
        >
          {bookmarks.map((bm) => (
            <Pressable
              key={bm.id}
              android_ripple={RIPPLE}
              style={[s.bmPill, { backgroundColor: t.inputBg }]}
              onPress={() => { setLoadedUrl(bm.url); setInputUrl(bm.url); }}
              onLongPress={() =>
                Alert.alert('Remove Bookmark', `Remove "${bm.title}"?`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Remove', style: 'destructive', onPress: () => removeBM(bm.id) },
                ])
              }
            >
              <Text style={[s.bmLabel, { color: t.label }]} numberOfLines={1}>{bm.title}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* ── WebView ──────────────────────────────────────────── */}
      <View style={s.webviewWrap}>
        <BrowserView
          ref={webviewRef}
          initialUrl={loadedUrl}
          key={loadedUrl}
          onMessage={onMessage}
          onNavigationChange={(url) => { setInputUrl(url); onPageChange(url); }}
          style={StyleSheet.absoluteFill}
        />
        {(videoCount > 0 || mseActive) && (
          <Pressable android_ripple={RIPPLE} style={s.floatingBadge} onPress={() => setVideosOpen(true)}>
            <Text style={s.floatingBadgeLabel}>
              {videoCount > 0 ? `${videoCount} video${videoCount !== 1 ? 's' : ''} found` : 'Stream detected'}
            </Text>
          </Pressable>
        )}
      </View>

      <DownloadProgressBar tasks={active} onCancel={cancel} />

      {/* ── Tab bar ──────────────────────────────────────────── */}
      <View style={[s.tabBar, { backgroundColor: t.surface, borderTopColor: t.sep }]}>
        <Pressable android_ripple={RIPPLE} style={s.tab} onPress={() => setVideosOpen(true)}>
          {IS_ANDROID && videoCount > 0 && (
            <View style={[s.tabIndicator, { backgroundColor: `${BLUE}22` }]} />
          )}
          <Text style={[s.tabLabel, { color: videoCount > 0 ? BLUE : t.label2 }]}>
            {videoCount > 0 ? `Videos  ${videoCount}` : 'Videos'}
          </Text>
        </Pressable>
        <View style={[s.tabDivider, { backgroundColor: t.sep }]} />
        <Pressable android_ripple={RIPPLE} style={s.tab} onPress={() => setDownloadsOpen(true)}>
          {IS_ANDROID && downloadCount > 0 && (
            <View style={[s.tabIndicator, { backgroundColor: `${GREEN}22` }]} />
          )}
          <Text style={[s.tabLabel, { color: downloadCount > 0 ? GREEN : t.label2 }]}>
            {downloadCount > 0 ? `Downloads  ${downloadCount}` : 'Downloads'}
          </Text>
        </Pressable>
      </View>

      {/* ──────────────────────────────────────────────────────── */}
      {/* Videos bottom sheet                                      */}
      {/* ──────────────────────────────────────────────────────── */}
      <Modal visible={videosOpen} transparent animationType="slide"
        onRequestClose={() => { setVideosOpen(false); setVideosSelectMode(false); setSelectedVideoIds(new Set()); }}>
        <Pressable style={s.backdrop} onPress={() => setVideosOpen(false)} />
        <View style={[s.sheet, { backgroundColor: t.pageBg }]}>
          {/* Drag handle */}
          <View style={[s.sheetHandle, { backgroundColor: t.label3 }]} />

          {/* Sheet header */}
          <View style={[s.sheetHeader, { backgroundColor: t.pageBg }]}>
            <View>
              <Text style={[s.sheetTitle, { color: t.label }]}>
                {videosSelectMode
                  ? `${selectedVideoIds.size} Selected`
                  : videoCount > 0 ? `${videoCount} Video${videoCount !== 1 ? 's' : ''} Found` : 'Videos'}
              </Text>
              {videosSelectMode ? (
                <Pressable android_ripple={RIPPLE_BL} hitSlop={S.sm} onPress={() => {
                  if (selectedVideoIds.size === allVideos.length) setSelectedVideoIds(new Set());
                  else setSelectedVideoIds(new Set(allVideos.map((v) => v.id)));
                }}>
                  <Text style={[s.sheetSubtitle, { color: BLUE }]}>
                    {selectedVideoIds.size === allVideos.length ? 'Deselect All' : 'Select All'}
                  </Text>
                </Pressable>
              ) : videoCount > 0 ? (
                <Text style={[s.sheetSubtitle, { color: t.label2 }]}>Tap Download to save</Text>
              ) : null}
            </View>
            <View style={s.sheetHeaderActions}>
              {allVideos.length > 0 && (
                <Pressable android_ripple={RIPPLE_BL} hitSlop={S.sm} onPress={() => {
                  setVideosSelectMode((m) => !m);
                  setSelectedVideoIds(new Set());
                }}>
                  <Text style={[s.dlDone, { color: BLUE }]}>{videosSelectMode ? 'Cancel' : 'Select'}</Text>
                </Pressable>
              )}
              <Pressable
                android_ripple={RIPPLE_BL}
                style={[s.closeButton, { backgroundColor: t.surface2 }]}
                onPress={() => { setVideosOpen(false); setVideosSelectMode(false); setSelectedVideoIds(new Set()); }}
                hitSlop={S.sm}>
                <Text style={[s.closeButtonLabel, { color: t.label2 }]}>✕</Text>
              </Pressable>
            </View>
          </View>

          {/* Video list */}
          <ScrollView
            style={s.sheetScroll}
            contentContainerStyle={s.sheetScrollContent}
            showsVerticalScrollIndicator={false}
          >
            {allVideos.length === 0 && !mseActive && (
              <View style={s.emptyState}>
                <Text style={[s.emptyEmoji, { color: t.label3 }]}>No videos yet</Text>
                <Text style={[s.emptyBody, { color: t.label2 }]}>
                  Browse to any page with a video and it will appear here automatically.
                </Text>
              </View>
            )}
            {mseActive && allVideos.length === 0 && (
              <View style={[s.infoCard, { backgroundColor: `${BLUE}14` }]}>
                <Text style={[s.infoCardText, { color: BLUE }]}>
                  A video is streaming on this page. Try pasting its URL below.
                </Text>
              </View>
            )}
            {allVideos.map((item) => {
              const source   = getSourceName(item.url);
              const quality  = getQuality(item.url);
              const format   = getFormatLabel(item.url);
              const selected = selectedVideoIds.has(item.id);
              return (
                <Pressable
                  key={item.id}
                  android_ripple={RIPPLE}
                  onPress={videosSelectMode ? () => toggleVideoSelect(item.id) : undefined}
                  style={[s.videoCard, { backgroundColor: selected ? `${BLUE}0D` : t.surface }, cardShadow]}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: S.sm }}>
                    {videosSelectMode && (
                      <View style={[s.checkCircle, {
                        borderColor: selected ? BLUE : t.label3,
                        backgroundColor: selected ? BLUE : 'transparent',
                        marginTop: 2,
                      }]}>
                        {selected && <Text style={s.checkMark}>✓</Text>}
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      {/* Row 1: source name + badges */}
                      <View style={s.videoCardRow}>
                        <Text style={[s.videoSource, { color: t.label }]}>{source}</Text>
                        <View style={s.badgeRow}>
                          {quality && (
                            <View style={[s.badge, { backgroundColor: `${BLUE}18` }]}>
                              <Text style={[s.badgeLabel, { color: BLUE }]}>{quality}</Text>
                            </View>
                          )}
                          <View style={[s.badge, { backgroundColor: t.surface2 }]}>
                            <Text style={[s.badgeLabel, { color: t.label2 }]}>{format}</Text>
                          </View>
                        </View>
                      </View>
                      {/* Row 2: truncated URL */}
                      <Text style={[s.videoUrl, { color: t.label2 }]} numberOfLines={1}>
                        {item.url.replace(/^https?:\/\//, '').split('?')[0]}
                      </Text>
                      {/* Row 3: actions (hidden in select mode) */}
                      {!videosSelectMode && (
                        <View style={s.videoActions}>
                          <Pressable android_ripple={RIPPLE} style={s.downloadButton} onPress={() => handleDownload(item)}>
                            <Text style={s.downloadButtonLabel}>Download</Text>
                          </Pressable>
                          <Pressable
                            android_ripple={RIPPLE}
                            style={[s.secondaryButton, { backgroundColor: t.surface2 }]}
                            onPress={() => { Clipboard.setString(item.url); showToast('Copied', 'success'); }}
                          >
                            <Text style={[s.secondaryButtonLabel, { color: t.label2 }]}>Copy</Text>
                          </Pressable>
                        </View>
                      )}
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>

          {/* Select action bar / Paste URL */}
          {videosSelectMode ? (
            <View style={[s.selectBar, { borderTopColor: t.sep, backgroundColor: t.pageBg }]}>
              <Text style={[s.selectBarCount, { color: t.label2 }]}>
                {selectedVideoIds.size} selected
              </Text>
              <Pressable
                android_ripple={RIPPLE}
                style={[s.selectBarButton, { opacity: selectedVideoIds.size === 0 ? 0.4 : 1 }]}
                onPress={handleDownloadSelected}
                disabled={selectedVideoIds.size === 0}
              >
                <Text style={s.selectBarButtonLabel}>
                  {selectedVideoIds.size > 0 ? `Download ${selectedVideoIds.size}` : 'Download'}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={[s.pasteRow, { borderTopColor: t.sep, backgroundColor: t.pageBg }]}>
              <TextInput
                style={[s.pasteInput, { backgroundColor: t.surface, color: t.label }]}
                value={manualUrl}
                onChangeText={setManualUrl}
                placeholder="Paste a video or social media URL…"
                placeholderTextColor={t.label3}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="done"
                onSubmitEditing={handleAddManual}
                editable={!extracting}
              />
              <Pressable
                android_ripple={RIPPLE}
                style={[s.pasteButton, extracting && { opacity: 0.6 }]}
                onPress={handleAddManual}
                disabled={extracting}
              >
                <Text style={s.pasteButtonLabel}>{extracting ? '…' : 'Add'}</Text>
              </Pressable>
            </View>
          )}
        </View>
      </Modal>

      {/* ──────────────────────────────────────────────────────── */}
      {/* Downloads full-screen                                    */}
      {/* ──────────────────────────────────────────────────────── */}
      <Modal visible={downloadsOpen} animationType="slide"
        onRequestClose={() => { setDownloadsOpen(false); setDownloadsSelectMode(false); setSelectedDlIds(new Set()); }}>
        <View style={[s.root, { backgroundColor: t.pageBg, paddingTop: TOP_PAD, paddingBottom: BOTTOM_PAD }]}>

          {/* Downloads header */}
          <View style={[s.dlHeader, { backgroundColor: t.surface, borderBottomColor: t.sep }]}>
            <Text style={[s.dlTitle, { color: t.label }]}>My Downloads</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.lg }}>
              {downloadCount > 0 && (
                <Pressable android_ripple={RIPPLE_BL} hitSlop={S.sm} onPress={() => {
                  setDownloadsSelectMode((m) => !m);
                  setSelectedDlIds(new Set());
                }}>
                  <Text style={[s.dlDone, { color: BLUE }]}>
                    {downloadsSelectMode ? 'Cancel' : 'Select'}
                  </Text>
                </Pressable>
              )}
              <Pressable android_ripple={RIPPLE_BL} hitSlop={S.sm} onPress={() => {
                setDownloadsOpen(false);
                setDownloadsSelectMode(false);
                setSelectedDlIds(new Set());
              }}>
                <Text style={[s.dlDone, { color: BLUE }]}>Done</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView contentContainerStyle={[s.dlScrollContent, downloadsSelectMode && { paddingBottom: S.xl }]}>
            {downloadCount === 0 && (
              <View style={s.emptyState}>
                <Text style={[s.emptyEmoji, { color: t.label3 }]}>No downloads yet</Text>
                <Text style={[s.emptyBody, { color: t.label2 }]}>
                  Find a video in the Videos tab and tap Download.
                </Text>
              </View>
            )}

            {allTasks.map((task) => {
              const source    = getSourceName(task.media.url);
              const size      = fileSizes[task.id];
              const isDone    = task.status === 'completed';
              const isFail    = task.status === 'failed';
              const isActive  = !isDone && !isFail && task.status !== 'cancelled';
              const isVideo   = !!task.localPlaylistPath &&
                /\.(mp4|ts|mov|webm|m4v)$/i.test(task.localPlaylistPath);
              const canSelect = isDone || isFail || task.status === 'cancelled';
              const selected  = selectedDlIds.has(task.id);

              const dotColor = isDone ? GREEN : isFail ? RED : BLUE;
              const statusText = isDone ? `Saved${size ? `  ·  ${size}` : ''}`
                : isFail        ? (task.error ?? 'Download failed')
                : task.status === 'downloading' && task.totalSegments > 0
                ? `Downloading  ${task.downloadedSegments} of ${task.totalSegments} parts`
                : task.status === 'assembling'        ? 'Assembling file…'
                : task.status === 'fetching_manifest' ? 'Reading stream…'
                : 'Starting…';

              return (
                <Pressable
                  key={task.id}
                  android_ripple={RIPPLE}
                  onPress={downloadsSelectMode && canSelect ? () => toggleDlSelect(task.id) : undefined}
                  style={[s.dlCard, { backgroundColor: selected ? `${BLUE}0D` : t.surface }, cardShadow]}
                >
                  {/* Status row */}
                  <View style={s.dlCardHeader}>
                    {downloadsSelectMode && canSelect ? (
                      <View style={[s.checkCircle, {
                        borderColor: selected ? BLUE : t.label3,
                        backgroundColor: selected ? BLUE : 'transparent',
                      }]}>
                        {selected && <Text style={s.checkMark}>✓</Text>}
                      </View>
                    ) : (
                      <View style={[s.statusDot, { backgroundColor: dotColor }]} />
                    )}
                    <Text style={[s.dlSource, { color: t.label }]}>{source}</Text>
                  </View>
                  <Text
                    style={[s.dlStatus, { color: isFail ? RED : t.label2 }]}
                    numberOfLines={2}
                  >
                    {statusText}
                  </Text>

                  {/* Progress bar (active only) */}
                  {isActive && (
                    <View style={[s.progressTrack, { backgroundColor: t.surface2 }]}>
                      <View style={[s.progressFill, {
                        width: `${Math.round(task.progress * 100)}%` as `${number}%`,
                      }]} />
                    </View>
                  )}

                  {/* Action buttons (hidden in select mode) */}
                  {!downloadsSelectMode && (isDone || isFail || isActive) && (
                    <View style={s.dlActions}>
                      {isActive && (
                        <Pressable android_ripple={RIPPLE} style={[s.actionChip, { backgroundColor: `${RED}14` }]}
                          onPress={() => cancel(task.id)}>
                          <Text style={[s.actionChipLabel, { color: RED }]}>Cancel</Text>
                        </Pressable>
                      )}
                      {isDone && task.localPlaylistPath && (
                        <>
                          <Pressable android_ripple={RIPPLE} style={[s.actionChip, { backgroundColor: `${BLUE}14` }]}
                            onPress={() => { setPlayingPath(task.localPlaylistPath!); setDownloadsOpen(false); }}>
                            <Text style={[s.actionChipLabel, { color: BLUE }]}>Play</Text>
                          </Pressable>
                          <Pressable android_ripple={RIPPLE} style={[s.actionChip, { backgroundColor: `${GREEN}14` }]}
                            onPress={() => handleExport(task)}>
                            <Text style={[s.actionChipLabel, { color: GREEN }]}>Export</Text>
                          </Pressable>
                          {isVideo && (
                            <Pressable android_ripple={RIPPLE} style={[s.actionChip, { backgroundColor: `${PURPLE}14` }]}
                              onPress={() => handleGallery(task)}>
                              <Text style={[s.actionChipLabel, { color: PURPLE }]}>Gallery</Text>
                            </Pressable>
                          )}
                        </>
                      )}
                      {isFail && (
                        <Pressable android_ripple={RIPPLE} style={[s.actionChip, { backgroundColor: `${ORANGE}14` }]}
                          onPress={() => handleRetry(task)}>
                          <Text style={[s.actionChipLabel, { color: ORANGE }]}>Retry</Text>
                        </Pressable>
                      )}
                      {(isDone || isFail || task.status === 'cancelled') && (
                        <Pressable
                          android_ripple={RIPPLE}
                          style={[s.actionChip, { backgroundColor: t.surface2 }]}
                          onPress={() =>
                            Alert.alert('Delete', 'Remove this download?', [
                              { text: 'Cancel', style: 'cancel' },
                              { text: 'Delete', style: 'destructive', onPress: () => remove(task.id) },
                            ])
                          }
                        >
                          <Text style={[s.actionChipLabel, { color: t.label2 }]}>Delete</Text>
                        </Pressable>
                      )}
                    </View>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>

          {/* Downloads selection bar */}
          {downloadsSelectMode && (
            <View style={[s.selectBar, { backgroundColor: t.surface, borderTopColor: t.sep }]}>
              <Pressable android_ripple={RIPPLE_BL} hitSlop={S.sm} onPress={() => {
                if (selectedDlIds.size === deletableTasks.length) setSelectedDlIds(new Set());
                else setSelectedDlIds(new Set(deletableTasks.map((tk) => tk.id)));
              }}>
                <Text style={[s.dlDone, { color: BLUE }]}>
                  {selectedDlIds.size === deletableTasks.length && deletableTasks.length > 0
                    ? 'Deselect All' : 'Select All'}
                </Text>
              </Pressable>
              <Pressable
                android_ripple={RIPPLE}
                style={[s.selectBarButton, {
                  backgroundColor: `${RED}14`,
                  opacity: selectedDlIds.size === 0 ? 0.4 : 1,
                }]}
                onPress={handleDeleteSelected}
                disabled={selectedDlIds.size === 0}
              >
                <Text style={[s.selectBarButtonLabel, { color: RED }]}>
                  {selectedDlIds.size > 0 ? `Delete ${selectedDlIds.size}` : 'Delete'}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      </Modal>

      {playingPath && <VideoPlayerModal path={playingPath} onClose={() => setPlayingPath(null)} />}
      <Toast message={toast} />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────
// Every numeric value is a multiple of 4 (half-step) or 8 (base).
// No arbitrary values. No random margins.
const s = StyleSheet.create({
  root: { flex: 1 },

  // ── Navigation bar ───────────────────────────────────────────
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: S.md,   // 16
    paddingVertical: S.sm,     // 8
    gap: S.sm,                 // 8
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  addressField: {
    flex: 1,
    height: 44,                // Apple HIG minimum tap target
    borderRadius: R.md,        // 12
    paddingHorizontal: S.md,   // 16
    fontSize: 15,
    fontWeight: '400',
  },
  goButton: {
    height: 44,
    paddingHorizontal: S.md,   // 16
    borderRadius: R.md,        // 12
    backgroundColor: BLUE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  goButtonLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: R.md,        // 12
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonLabel: {
    fontSize: 20,
    lineHeight: 24,
  },

  // ── Bookmark strip ────────────────────────────────────────────
  bmBar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    maxHeight: 52,
  },
  bmContent: {
    paddingHorizontal: S.md,   // 16
    paddingVertical: S.sm,     // 8
    gap: S.sm,                 // 8
    flexDirection: 'row',
    alignItems: 'center',
  },
  bmPill: {
    height: 36,
    paddingHorizontal: S.md,   // 16
    borderRadius: R.sm,        // 8
    alignItems: 'center',
    justifyContent: 'center',
    maxWidth: 160,
  },
  bmLabel: {
    fontSize: 13,
    fontWeight: '500',
  },

  // ── WebView ───────────────────────────────────────────────────
  webviewWrap: { flex: 1 },
  floatingBadge: {
    position: 'absolute',
    top: S.md,                 // 16
    alignSelf: 'center',
    backgroundColor: BLUE,
    paddingHorizontal: S.md,   // 16
    paddingVertical: S.sm,     // 8
    borderRadius: 100,
    ...( IS_IOS
      ? { shadowColor: BLUE, shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } }
      : { elevation: 6 }
    ),
  },
  floatingBadgeLabel: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },

  // ── Tab bar ───────────────────────────────────────────────────
  tabBar: {
    flexDirection: 'row',
    height: 52,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',        // clip ripple to tab bounds
  },
  tabIndicator: {
    position: 'absolute',
    height: 32,
    borderRadius: 16,
    width: '80%',
  },
  tabLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  tabDivider: {
    width: StyleSheet.hairlineWidth,
    marginVertical: S.md,      // 16
  },

  // ── Bottom sheet (Videos) ─────────────────────────────────────
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    borderTopLeftRadius: R.sheet,   // 20
    borderTopRightRadius: R.sheet,  // 20
    paddingBottom: BOTTOM_PAD + S.md,
    maxHeight: '85%',
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: S.sm,           // 8
    marginBottom: S.md,        // 16
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: S.md,   // 16
    marginBottom: S.md,        // 16
  },
  sheetTitle: {
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  sheetSubtitle: {
    fontSize: 14,
    fontWeight: '400',
    marginTop: S.xs,           // 4
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  sheetScroll: { maxHeight: 400 },
  sheetScrollContent: {
    paddingHorizontal: S.md,   // 16
    paddingBottom: S.sm,       // 8
  },

  // ── Video card ────────────────────────────────────────────────
  videoCard: {
    borderRadius: R.lg,        // 14
    padding: S.md,             // 16
    marginBottom: S.sm,        // 8
  },
  videoCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: S.xs,        // 4
  },
  videoSource: {
    fontSize: 16,
    fontWeight: '600',
  },
  badgeRow: {
    flexDirection: 'row',
    gap: S.xs,                 // 4
  },
  badge: {
    paddingHorizontal: S.sm,   // 8
    paddingVertical: S.xs,     // 4
    borderRadius: S.xs,        // 4
  },
  badgeLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  videoUrl: {
    fontSize: 13,
    fontWeight: '400',
    marginBottom: S.md,        // 16
    lineHeight: 18,
  },
  videoActions: {
    flexDirection: 'row',
    gap: S.sm,                 // 8
  },
  downloadButton: {
    flex: 1,
    height: 44,
    backgroundColor: BLUE,
    borderRadius: R.md,        // 12
    alignItems: 'center',
    justifyContent: 'center',
  },
  downloadButtonLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButton: {
    height: 44,
    paddingHorizontal: S.md,   // 16
    borderRadius: R.md,        // 12
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonLabel: {
    fontSize: 15,
    fontWeight: '600',
  },

  // ── Paste row ─────────────────────────────────────────────────
  pasteRow: {
    flexDirection: 'row',
    gap: S.sm,                 // 8
    paddingHorizontal: S.md,   // 16
    paddingTop: S.md,          // 16
    paddingBottom: S.xs,       // 4
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  pasteInput: {
    flex: 1,
    height: 44,
    borderRadius: R.md,        // 12
    paddingHorizontal: S.md,   // 16
    fontSize: 14,
    fontWeight: '400',
  },
  pasteButton: {
    height: 44,
    paddingHorizontal: S.md,   // 16
    borderRadius: R.md,        // 12
    backgroundColor: BLUE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pasteButtonLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },

  // ── Empty state ───────────────────────────────────────────────
  emptyState: {
    alignItems: 'center',
    paddingVertical: S.xl,     // 32
    paddingHorizontal: S.xl,   // 32
  },
  emptyEmoji: {
    fontSize: 17,
    fontWeight: '600',
    marginBottom: S.sm,        // 8
  },
  emptyBody: {
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 22,
    textAlign: 'center',
  },
  infoCard: {
    borderRadius: R.md,        // 12
    padding: S.md,             // 16
    marginBottom: S.sm,        // 8
  },
  infoCardText: {
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
  },

  // ── Downloads screen ──────────────────────────────────────────
  dlHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: S.md,   // 16
    paddingVertical: S.md,     // 16
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dlTitle: {
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  dlDone: {
    fontSize: 16,
    fontWeight: '600',
  },
  dlScrollContent: {
    padding: S.md,             // 16
  },

  // ── Download card ─────────────────────────────────────────────
  dlCard: {
    borderRadius: R.lg,        // 14
    padding: S.md,             // 16
    marginBottom: S.sm,        // 8
  },
  dlCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.sm,                 // 8
    marginBottom: S.xs,        // 4
  },
  statusDot: {
    width: S.sm,               // 8
    height: S.sm,              // 8
    borderRadius: S.xs,        // 4
  },
  dlSource: {
    fontSize: 16,
    fontWeight: '600',
  },
  dlStatus: {
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 20,
    marginBottom: S.sm,        // 8
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: S.sm,        // 8
  },
  progressFill: {
    height: 4,
    backgroundColor: BLUE,
    borderRadius: 2,
  },
  dlActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: S.sm,                 // 8
    marginTop: S.xs,           // 4
  },
  actionChip: {
    height: 36,
    paddingHorizontal: S.md,   // 16
    borderRadius: S.sm,        // 8
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionChipLabel: {
    fontSize: 14,
    fontWeight: '600',
  },

  // ── Sheet header actions ──────────────────────────────────────
  sheetHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.md,                 // 16
  },

  // ── Multi-select ──────────────────────────────────────────────
  checkCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  checkMark: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 16,
  },
  selectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: S.md,   // 16
    paddingVertical: S.md,     // 16
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  selectBarCount: {
    fontSize: 14,
    fontWeight: '500',
  },
  selectBarButton: {
    height: 44,
    paddingHorizontal: S.lg,   // 24
    borderRadius: R.md,        // 12
    backgroundColor: BLUE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectBarButtonLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
});

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Dimensions,
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
import * as Linking from 'expo-linking';

import BrowserView from './src/components/BrowserView';
import Toast, { ToastMessage } from './src/components/Toast';
import VideoPlayerModal from './src/components/VideoPlayerModal';
import SettingsSheet from './src/components/SettingsSheet';

import { useMediaDetection } from './src/hooks/useMediaDetection';
import { useDownloadManager } from './src/hooks/useDownloadManager';
import { useBookmarks } from './src/hooks/useBookmarks';
import { useSettings } from './src/hooks/useSettings';
import { DetectedMedia, DownloadTask } from './src/types';
import { extractFromSocialUrl, isSocialPageUrl } from './src/lib/platformExtractors';

// ── Layout constants ──────────────────────────────────────────
const TOP_PAD    = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 0;
const BOTTOM_PAD = Platform.OS === 'android' ? 16 : 0;
const IS_IOS     = Platform.OS === 'ios';
const IS_ANDROID = Platform.OS === 'android';
const SCREEN_W   = Dimensions.get('window').width;

// ── Ripple ────────────────────────────────────────────────────
const RIPPLE    = IS_ANDROID ? { color: 'rgba(0,0,0,0.06)', borderless: false } : undefined;
const RIPPLE_BL = IS_ANDROID ? { color: 'rgba(0,0,0,0.06)', borderless: true  } : undefined;

// ── Spacing / radius ──────────────────────────────────────────
const S = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
const R = { sm: 8, md: 12, lg: 16, xl: 20 } as const;

// ── Color tokens ──────────────────────────────────────────────
// Light
const L = {
  bg:     '#FFFFFF',
  card:   '#F5F5F5',
  card2:  '#EBEBEB',
  sep:    '#E8E8E8',
  ink:    '#1A1A1A',
  ink2:   '#8A8A8A',
  ink3:   '#C0C0C0',
  btn:    '#1A1A1A',   // primary button fill
  btnTxt: '#FFFFFF',
  red:    '#C0392B',
  redBg:  '#FDF2F2',
} as const;

// Dark
const D = {
  bg:     '#0D0D0D',
  card:   '#1A1A1A',
  card2:  '#252525',
  sep:    '#2A2A2A',
  ink:    '#F2F2F2',
  ink2:   '#888888',
  ink3:   '#404040',
  btn:    '#F2F2F2',
  btnTxt: '#0D0D0D',
  red:    '#E05A5A',
  redBg:  '#2A1515',
} as const;

function useTheme(darkOverride?: boolean) {
  const systemDark = useColorScheme() === 'dark';
  const dark = darkOverride ?? systemDark;
  const c = dark ? D : L;
  return { ...c, dark,
    ripple: dark ? { color: 'rgba(255,255,255,0.06)', borderless: false } : RIPPLE,
  };
}

// ── Helpers ───────────────────────────────────────────────────

function getSourceName(url: string): string {
  if (/video\.twimg\.com|twimg\.com/i.test(url))                                            return 'Twitter';
  if (/cdninstagram\.com|instagram\.com/i.test(url))                                        return 'Instagram';
  if (/threads\.net/i.test(url))                                                             return 'Threads';
  if (/vimeocdn\.com|vimeo\.com/i.test(url))                                                return 'Vimeo';
  if (/tiktokcdn\.com|tiktokcdn-us\.com|v\d+-webapp\.tiktok\.com|tiktok\.com/i.test(url))  return 'TikTok';
  if (/v\.redd\.it|reddit\.com/i.test(url))                                                 return 'Reddit';
  if (/googlevideo\.com|youtube\.com/i.test(url))                                           return 'YouTube';
  if (/dailymotion\.com|dmcdn\.net/i.test(url))                                             return 'Dailymotion';
  if (/facebook\.com|fbcdn\.net/i.test(url))                                                return 'Facebook';
  if (/twitch\.tv|usher\.twitch\.tv/i.test(url))                                            return 'Twitch';
  if (/pinimg\.com|pinterest\.com/i.test(url))                                              return 'Pinterest';
  if (/bilivideo\.com|bilibili\.com|bilibili\.tv|b23\.tv/i.test(url))                       return 'Bilibili';
  if (/weibo\.com|weibo\.cn|weibocdn\.com|sinaimg\.cn/i.test(url))                          return 'Weibo';
  if (/xiaohongshu\.com|xhslink\.com|xhscdn\.com/i.test(url))                                return 'Xiaohongshu';
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const name = host.split('.').slice(-2, -1)[0] ?? 'Video';
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch { return 'Video'; }
}

function getMediaKind(item: Pick<DetectedMedia, 'url' | 'mimeType' | 'mediaKind'>): NonNullable<DetectedMedia['mediaKind']> {
  if (item.mediaKind) return item.mediaKind;
  const u = item.url.toLowerCase().split('?')[0];
  const mt = String(item.mimeType || '').toLowerCase();
  if (mt.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|heic)$/.test(u)) return 'image';
  if (mt.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/.test(u)) return 'audio';
  return 'video';
}

function getQuality(url: string, label?: string): string | null {
  if (label) return label;
  const ytH = url.match(/[?&]height=(\d+)/i);
  if (ytH) {
    const h = parseInt(ytH[1], 10);
    if (h >= 2160) return '4K';
    if (h >= 1080) return '1080p';
    if (h >= 720)  return '720p';
    if (h >= 480)  return '480p';
    if (h >= 360)  return '360p';
  }
  if (/4k|2160/i.test(url)) return '4K';
  if (/1080/i.test(url))    return '1080p';
  if (/720/i.test(url))     return '720p';
  if (/480/i.test(url))     return '480p';
  if (/360/i.test(url))     return '360p';
  if (/\bhd\b/i.test(url))  return 'HD';
  return null;
}

function getMediaFormat(item: DetectedMedia): string {
  const kind = getMediaKind(item);
  const u = item.url.toLowerCase();
  if (item.mediaType === 'hls' || u.includes('.m3u8')) return 'HLS Stream';
  if (item.mediaType === 'dash' || u.includes('.mpd')) return 'DASH Stream';
  const ext = u.split('?')[0].match(/\.([a-z0-9]{2,5})$/)?.[1];
  if (ext) return ext.toUpperCase();
  if (item.mimeType) return item.mimeType;
  return kind === 'image' ? 'Image' : kind === 'audio' ? 'Audio' : 'Video';
}

function getMimeFromPath(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith('.mp4')) return 'video/mp4';
  if (p.endsWith('.webm')) return 'video/webm';
  if (p.endsWith('.mov')) return 'video/quicktime';
  if (p.endsWith('.ts')) return 'video/mp2t';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.gif')) return 'image/gif';
  if (p.endsWith('.avif')) return 'image/avif';
  if (p.endsWith('.mp3')) return 'audio/mpeg';
  if (p.endsWith('.m4a')) return 'audio/mp4';
  if (p.endsWith('.wav')) return 'audio/wav';
  if (p.endsWith('.ogg')) return 'audio/ogg';
  return 'application/octet-stream';
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

function getInitial(name: string): string {
  return (name[0] ?? '?').toUpperCase();
}

// ── URL classification ────────────────────────────────────────

const SEGMENT_RE     = /\.(ts|m4s|aac|m4a|cmfv|cmfa)(\?|#|$)/i;
const VIMEO_RANGE_RE = /vimeocdn\.com\/.*\/v2\/range\/.*\/avf\//i;
const USEFUL_EXT_RE  = /\.(m3u8|mpd|mp4|m4v|webm|mov|jpe?g|png|webp|gif|avif|heic|mp3|m4a|aac|wav|ogg|opus|flac)(\?|#|$)/i;
const VIMEO_JSON_RE  = /vimeocdn\.com\/.*\/playlist\.json(\?|$)/i;
const VIDEO_CDN_RE   = /(?:googlevideo\.com\/videoplayback|video\.twimg\.com\/|cdninstagram\.com\/|scontent[-\w]*\.cdninstagram\.com\/|threadscdn\.com\/|tiktokcdn\.com\/|tiktokcdn-us\.com\/|v\d+-webapp\.tiktok\.com\/|v\.redd\.it\/|fbcdn\.net\/videos|pinimg\.com\/videos\/|dmcdn\.net\/|usher\.twitch\.tv\/|bilivideo\.com\/|weibocdn\.com\/|xhscdn\.com\/)/i;
const YT_RANGE_RE    = /googlevideo\.com\/videoplayback[^#]*[?&](?:range=|sq=)\d/i;

function isUseful(url: string): boolean {
  const clean = url.split('#')[0];
  if (SEGMENT_RE.test(clean))   return false;
  if (VIMEO_RANGE_RE.test(url)) return false;
  if (YT_RANGE_RE.test(url))   return false;
  return USEFUL_EXT_RE.test(url) || VIMEO_JSON_RE.test(url) || VIDEO_CDN_RE.test(url);
}

function isDirectMediaUrl(url: string): boolean {
  const clean = url.split('#')[0];
  if (SEGMENT_RE.test(clean)) return false;
  if (YT_RANGE_RE.test(url)) return false;
  return USEFUL_EXT_RE.test(url) || VIMEO_JSON_RE.test(url) || VIDEO_CDN_RE.test(url);
}

function guessMediaType(url: string): DetectedMedia['mediaType'] {
  const lower = url.toLowerCase();
  if (lower.includes('.mpd')) return 'dash';
  if (lower.includes('.m3u8')) return 'hls';
  return 'direct';
}

// ── Dedup ─────────────────────────────────────────────────────

const YT_CDN_RE   = /googlevideo\.com\/videoplayback/i;
const TW_VIDEO_RE = /video\.twimg\.com\/(?:ext_tw_video|amplify_video)\/(\d+)\//i;

const YT_ITAG_RANK: Record<number, number> = {
  22: 100, 59: 90, 78: 85, 18: 70, 36: 40, 17: 20,
};

function getVideoGroupKey(url: string): string | null {
  try {
    if (YT_CDN_RE.test(url)) {
      const id = new URL(url).searchParams.get('id');
      return id ? `yt_${id}` : null;
    }
    const ytM = url.match(/manifest\.googlevideo\.com\/api\/manifest\/[^/]+\/.*?\/id\/([^/.]+)/);
    if (ytM) return `ytm_${ytM[1]}`;
    const tw = url.match(TW_VIDEO_RE);
    if (tw) return `tw_${tw[1]}`;
    return null;
  } catch { return null; }
}

function getQualityScore(url: string): number {
  if (YT_CDN_RE.test(url)) {
    try {
      const p = new URL(url).searchParams;
      const itag = parseInt(p.get('itag') ?? '0', 10);
      if ((p.get('mime') ?? '').startsWith('audio/')) return -1;
      return YT_ITAG_RANK[itag] ?? 1;
    } catch { return 1; }
  }
  const res = url.match(/\/(\d+)x(\d+)\//);
  if (!res && /\.m3u8/i.test(url)) return 10_000_000;
  if (res) return parseInt(res[1]) * parseInt(res[2]) + (/\.m3u8/i.test(url) ? 1 : 0);
  const u = url.toLowerCase();
  if (/\.mpd/.test(u))                return 3_000_000;
  if (/\.(mp4|m4v|webm|mov)/.test(u)) return 100;
  return 50;
}

function smartDedup(items: DetectedMedia[]): DetectedMedia[] {
  const grouped  = new Map<string, { item: DetectedMedia; score: number }>();
  const ungrouped: DetectedMedia[] = [];
  for (const item of items) {
    const urlScore = getQualityScore(item.url);
    if (urlScore < 0) continue;
    const score = urlScore * (1 + (item.confidence ?? 0.5) * 0.2);
    const key   = getVideoGroupKey(item.url);
    if (key) {
      const ex = grouped.get(key);
      if (!ex || score > ex.score) grouped.set(key, { item, score });
    } else {
      ungrouped.push(item);
    }
  }
  return [...Array.from(grouped.values()).map((e) => e.item), ...ungrouped];
}

// ── Shadow ────────────────────────────────────────────────────
const subtleShadow = IS_IOS
  ? { shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } }
  : { elevation: 1 };

// ─────────────────────────────────────────────────────────────
type Tab = 'home' | 'browser' | 'library' | 'bookmarks';

export default function App() {
  const { theme, fontSize, fontScale, setTheme, setFontSize } = useSettings();
  const systemDark = useColorScheme() === 'dark';
  const isDark = theme === 'system' ? systemDark : theme === 'dark';
  const t  = useTheme(isDark);
  const fs = (base: number) => base * fontScale;
  const webviewRef = useRef<WebView>(null);

  // ── Navigation ────────────────────────────────────────────
  const [tab, setTab]               = useState<Tab>('home');
  const [pasteUrl, setPasteUrl]     = useState('');
  const [browserInput, setBrowserInput] = useState('');
  const [loadedUrl, setLoadedUrl]   = useState('about:blank');

  // ── UI ────────────────────────────────────────────────────
  const [videosOpen, setVideosOpen]     = useState(false);
  const [previewItem, setPreviewItem]   = useState<DetectedMedia | null>(null);
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
        if (mediaUrl) { setPasteUrl(mediaUrl); setTab('home'); showToast('Link received — tap Download', 'success'); }
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
    onComplete: useCallback(() => showToast('Download complete', 'success'), [showToast]),
    onError:    useCallback((task: DownloadTask) =>
      showToast(`Failed: ${task.error ?? 'unknown error'}`, 'error'), [showToast]),
  });

  // ── Detected videos ───────────────────────────────────────
  const allVideos = useMemo<DetectedMedia[]>(() => {
    const seen = new Set(detected.map((m) => m.url));
    const fromNet: DetectedMedia[] = networkLog
      .filter((url) => isUseful(url) && !seen.has(url))
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

  // ── Home: paste → download ────────────────────────────────
  const handleHomeDownload = useCallback(async () => {
    let url = pasteUrl.trim();
    if (!url || extracting) return;
    if (!url.startsWith('http')) url = `https://${url}`;

    if (isSocialPageUrl(url)) {
      setExtracting(true);
      try {
        const items = await extractFromSocialUrl(url);
        if (items.length > 0) {
          for (const item of items) await enqueue(item);
          setPasteUrl('');
          showToast(`Downloading ${items.length} media item${items.length !== 1 ? 's' : ''}`, 'success');
          setTab('library');
        } else {
          showToast('Opening in browser — tap the video button when it appears', 'info');
          setLoadedUrl(url); setBrowserInput(url); setTab('browser');
        }
      } catch {
        showToast('Opening in browser instead', 'info');
        setLoadedUrl(url); setBrowserInput(url); setTab('browser');
      } finally { setExtracting(false); }
      return;
    }

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
      showToast('Download started', 'success');
      setTab('library');
      return;
    }

    showToast('Opening in browser', 'info');
    setLoadedUrl(url); setBrowserInput(url); setTab('browser');
  }, [pasteUrl, extracting, enqueue, showToast]);

  // ── Browser: download detected video ─────────────────────
  const handleDetectedDownload = useCallback(async (item: DetectedMedia) => {
    setVideosOpen(false);
    setPreviewItem(null);
    await enqueue(item);
    showToast('Download started', 'success');
    setTab('library');
  }, [enqueue, showToast]);

  // ── Export / Gallery ──────────────────────────────────────
  const handleExport = useCallback(async (task: DownloadTask) => {
    if (!task.localPlaylistPath) return;
    try {
      if (!(await Sharing.isAvailableAsync())) { showToast('Sharing not available', 'error'); return; }
      const path = task.localPlaylistPath;
      const mime = getMimeFromPath(path);
      await Sharing.shareAsync(path, { mimeType: mime, dialogTitle: 'Export media' });
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
    retry(task.id, task.strategy);
    showToast('Retrying…', 'info');
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
    Alert.alert('Delete', `Delete ${ids.length} item${ids.length !== 1 ? 's' : ''}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        for (const id of ids) await remove(id);
        setLibSelectMode(false);
        setLibSelected(new Set());
      }},
    ]);
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
              ? <Text style={[s.largeTitleIOS, { color: t.ink }]}>Downloader</Text>
              : <Text style={[s.titleAndroid, { color: t.ink }]}>Downloader</Text>
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
              <Text style={[s.pasteLabel, { color: t.ink2, fontSize: fs(12) }]}>
                VIDEO OR PAGE LINK
              </Text>
              <TextInput
                style={[s.pasteInput, { backgroundColor: t.card, color: t.ink, fontSize: fs(15),
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
                placeholder="Paste URL here"
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
                  {extracting ? 'Finding…' : 'Download'}
                </Text>
              </Pressable>
              <Pressable onPress={() => setTab('browser')} hitSlop={S.xs} style={s.browseLink}>
                <Text style={[s.browseLinkLabel, { color: t.ink2, fontSize: fs(13) }]}>
                  or browse for media →
                </Text>
              </Pressable>
              <Text style={[s.browseHint, { color: t.ink3, fontSize: fs(11) }]}>
                Tip: signing in via Browse unlocks HD media on more sites
              </Text>
            </View>

            {/* Active downloads (compact) */}
            {active.length > 0 && (
              <View style={s.section}>
                <Text style={[s.sectionLabel, { color: t.ink2, fontSize: fs(11) }]}>IN PROGRESS</Text>
                {active.map((task) => (
                  <View key={task.id} style={[s.compactCard, { backgroundColor: t.card }, subtleShadow]}>
                    <View style={s.compactRow}>
                      <Text style={[s.compactSource, { color: t.ink, fontSize: fs(14) }]}>
                        {getSourceName(task.media.url)}
                      </Text>
                      <Text style={[s.compactPct, { color: t.ink2, fontSize: fs(13) }]}>
                        {Math.round(task.progress * 100)}%
                      </Text>
                      <Pressable android_ripple={RIPPLE_BL} onPress={() => cancel(task.id)} hitSlop={S.xs}
                        style={[s.cancelBtn, { borderColor: t.sep }]}>
                        <Text style={[s.cancelBtnLabel, { color: t.ink2, fontSize: fs(12) }]}>Cancel</Text>
                      </Pressable>
                    </View>
                    <View style={[s.progressTrack, { backgroundColor: t.card2 }]}>
                      <View style={[s.progressFill, { backgroundColor: t.btn,
                        width: `${Math.round(task.progress * 100)}%` as `${number}%` }]} />
                    </View>
                    <Text style={[s.compactStatus, { color: t.ink2, fontSize: fs(11) }]}>
                      {task.status === 'downloading' && task.totalSegments > 0
                        ? `${task.downloadedSegments} / ${task.totalSegments} parts`
                        : task.status === 'assembling'        ? 'Assembling…'
                        : task.status === 'fetching_manifest' ? 'Reading stream…'
                        : 'Starting…'}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {/* Empty state */}
            {active.length === 0 && allTasks.length === 0 && (
              <View style={s.emptyHome}>
                <Text style={[s.emptyHomeIcon, { color: t.ink3 }]}>↓</Text>
                <Text style={[s.emptyHomeText, { color: t.ink2, fontSize: fs(14) }]}>
                  Paste a link to start downloading
                </Text>
              </View>
            )}
            {active.length === 0 && allTasks.length > 0 && (
              <Pressable android_ripple={RIPPLE} style={[s.libraryLink, { backgroundColor: t.card }, subtleShadow]}
                onPress={() => setTab('library')}>
                <Text style={[s.libraryLinkLabel, { color: t.ink, fontSize: fs(14) }]}>
                  {allTasks.length} item{allTasks.length !== 1 ? 's' : ''} in Library
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
              style={[s.addressField, { backgroundColor: t.card, color: t.ink, fontSize: fs(14) }]}
              value={browserInput}
              onChangeText={setBrowserInput}
              onSubmitEditing={navigateBrowser}
              placeholder="Search or enter URL"
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
          </View>

          <View style={s.flex}>
            {loadedUrl === 'about:blank' ? (
              <View style={[s.flex, s.center, { backgroundColor: t.bg }]}>
                <Text style={[s.emptyHomeText, { color: t.ink2, fontSize: fs(14) }]}>
                  Enter a URL above to start browsing
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
                  {mediaCount > 0 ? `${mediaCount} media item${mediaCount !== 1 ? 's' : ''} found` : 'Stream detected'}
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
              <Text style={[s.activeStripLabel, { color: t.ink2, fontSize: fs(11) }]}>
                {activeCount} download{activeCount !== 1 ? 's' : ''} in progress
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
                <Pressable onPress={exitLibSelectMode} hitSlop={S.sm} android_ripple={RIPPLE_BL}>
                  <Text style={[{ color: t.ink, fontSize: fs(15) }]}>Cancel</Text>
                </Pressable>
                <Pressable onPress={selectAllLib} hitSlop={S.sm} android_ripple={RIPPLE_BL} style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={[{ color: t.btn, fontSize: fs(15), fontWeight: '500' }]}>
                    {libSelected.size === history.length && history.length > 0 ? 'Deselect All' : 'Select All'}
                  </Text>
                </Pressable>
                <Pressable onPress={deleteLibSelected} hitSlop={S.sm} android_ripple={RIPPLE_BL}
                  disabled={libSelected.size === 0}>
                  <Text style={[{ fontSize: fs(15), fontWeight: '500',
                    color: libSelected.size > 0 ? t.red : t.ink3 }]}>
                    Delete
                  </Text>
                </Pressable>
              </>
            ) : (
              <>
                {IS_IOS
                  ? <Text style={[s.largeTitleIOS, { color: t.ink }]}>Library</Text>
                  : <Text style={[s.titleAndroid, { color: t.ink }]}>Library</Text>
                }
                {history.length > 0 && (
                  <Pressable onPress={() => { setLibSelectMode(true); setLibSelected(new Set()); }}
                    hitSlop={S.sm} android_ripple={RIPPLE_BL}>
                    <Text style={[{ color: t.ink2, fontSize: fs(14) }]}>Select</Text>
                  </Pressable>
                )}
              </>
            )}
          </View>

          {allTasks.length === 0 ? (
            <View style={[s.flex, s.center, { backgroundColor: t.bg }]}>
              <Text style={[s.emptyHomeIcon, { color: t.ink3 }]}>⊘</Text>
              <Text style={[s.emptyHomeText, { color: t.ink2, fontSize: fs(14) }]}>No downloads yet</Text>
              <Pressable onPress={() => setTab('home')} hitSlop={S.xs} style={{ marginTop: S.sm }}>
                <Text style={[s.browseLinkLabel, { color: t.ink2, fontSize: fs(13) }]}>
                  Go to Home →
                </Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView contentContainerStyle={[s.gridContent, { paddingBottom: BOTTOM_PAD + 80 }]}
              showsVerticalScrollIndicator={false}>

              {/* Active downloads */}
              {active.length > 0 && (
                <>
                  <Text style={[s.sectionLabel, { color: t.ink2, fontSize: fs(11), marginBottom: S.sm }]}>
                    IN PROGRESS
                  </Text>
                  {active.map((task) => (
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
                          <Text style={[s.libraryCardTitle, { color: t.ink, fontSize: fs(14) }]}>
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
                        <Text style={[s.libraryCardSub, { color: t.ink2, fontSize: fs(11) }]}>
                          {task.status === 'downloading' && task.totalSegments > 0
                            ? `${task.downloadedSegments} / ${task.totalSegments} parts`
                            : task.status === 'assembling'        ? 'Assembling…'
                            : task.status === 'fetching_manifest' ? 'Reading stream…'
                            : 'Starting…'}
                        </Text>
                        <Pressable android_ripple={RIPPLE_BL} onPress={() => cancel(task.id)}
                          style={[s.outlineBtn, { borderColor: t.sep, marginTop: S.xs }]}>
                          <Text style={[s.outlineBtnLabel, { color: t.ink2, fontSize: fs(12) }]}>Cancel</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                  {history.length > 0 && <View style={[s.sep, { backgroundColor: t.sep }]} />}
                </>
              )}

              {/* Completed / failed / cancelled */}
              {history.length > 0 && active.length > 0 && (
                <Text style={[s.sectionLabel, { color: t.ink2, fontSize: fs(11), marginBottom: S.sm }]}>
                  COMPLETED
                </Text>
              )}
              {history.map((task) => {
                const source      = getSourceName(task.media.url);
                const quality     = getQuality(task.media.url, task.media.label);
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
                        <Text style={[s.libraryCardTitle, { color: t.ink, fontSize: fs(14) }]}>
                          {source}
                        </Text>
                        {quality && (
                          <View style={[s.badge, { backgroundColor: t.card2 }]}>
                            <Text style={[s.badgeLabel, { color: t.ink2, fontSize: fs(10) }]}>{quality}</Text>
                          </View>
                        )}
                      </View>
                      <Text style={[s.libraryCardSub,
                        { color: isFail ? t.red : t.ink2, fontSize: fs(12) }]} numberOfLines={1}>
                        {isDone   ? `Saved${size ? `  ·  ${size}` : ''}`
                         : isFail ? (task.error ?? 'Failed')
                         : 'Cancelled'}
                      </Text>

                      {!libSelectMode && (
                        <View style={s.libraryActions}>
                          {isDone && task.localPlaylistPath && (
                            <>
                              {isPlayable && (
                                <Pressable android_ripple={RIPPLE_BL}
                                  style={[s.outlineBtn, { borderColor: t.sep }]}
                                  onPress={() => setPlayingPath(task.localPlaylistPath!)}>
                                  <Text style={[s.outlineBtnLabel, { color: t.ink, fontSize: fs(12) }]}>Play</Text>
                                </Pressable>
                              )}
                              <Pressable android_ripple={RIPPLE_BL}
                                style={[s.outlineBtn, { borderColor: t.sep }]}
                                onPress={() => handleExport(task)}>
                                <Text style={[s.outlineBtnLabel, { color: t.ink, fontSize: fs(12) }]}>Share</Text>
                              </Pressable>
                              {canSaveToLibrary && (
                                <Pressable android_ripple={RIPPLE_BL}
                                  style={[s.outlineBtn, { borderColor: t.sep }]}
                                  onPress={() => handleGallery(task)}>
                                  <Text style={[s.outlineBtnLabel, { color: t.ink, fontSize: fs(12) }]}>Gallery</Text>
                                </Pressable>
                              )}
                            </>
                          )}
                          {isFail && (
                            <Pressable android_ripple={RIPPLE_BL}
                              style={[s.outlineBtn, { borderColor: t.sep }]}
                              onPress={() => handleRetry(task)}>
                              <Text style={[s.outlineBtnLabel, { color: t.ink, fontSize: fs(12) }]}>Retry</Text>
                            </Pressable>
                          )}
                          <Pressable android_ripple={RIPPLE_BL}
                            style={[s.outlineBtn, { borderColor: t.redBg }]}
                            onPress={() => Alert.alert('Delete', 'Remove this download?', [
                              { text: 'Cancel', style: 'cancel' },
                              { text: 'Delete', style: 'destructive', onPress: () => remove(task.id) },
                            ])}>
                            <Text style={[s.outlineBtnLabel, { color: t.red, fontSize: fs(12) }]}>Delete</Text>
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
              ? <Text style={[s.largeTitleIOS, { color: t.ink }]}>Bookmarks</Text>
              : <Text style={[s.titleAndroid, { color: t.ink }]}>Bookmarks</Text>
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
                No bookmarks yet
              </Text>
              <Pressable onPress={() => setTab('browser')} hitSlop={S.xs} style={{ marginTop: S.sm }}>
                <Text style={[s.browseLinkLabel, { color: t.ink2, fontSize: fs(13) }]}>
                  Browse and tap ★ to save →
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
                    onLongPress={() => Alert.alert('Remove Bookmark', `Remove "${bm.title || domain}"?`, [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Remove', style: 'destructive', onPress: () => removeBM(bm.id) },
                    ])}>
                    <View style={[s.bmRowAvatar, { backgroundColor: t.card2 }]}>
                      <Text style={[s.bmRowAvatarText, { color: t.ink, fontSize: fs(16) }]}>
                        {getInitial(bm.title || domain)}
                      </Text>
                    </View>
                    <View style={s.bmRowBody}>
                      <Text style={[s.bmRowTitle, { color: t.ink, fontSize: fs(14) }]} numberOfLines={1}>
                        {bm.title || domain}
                      </Text>
                      {domain ? (
                        <Text style={[s.bmRowUrl, { color: t.ink2, fontSize: fs(12) }]} numberOfLines={1}>
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
      <View style={[s.tabBar, { backgroundColor: t.bg, borderTopColor: t.sep, paddingBottom: BOTTOM_PAD }]}>
        {(['home', 'browser', 'library', 'bookmarks'] as Tab[]).map((id, idx) => {
          const labels: Record<Tab, string> = {
            home:      activeCount > 0 ? `Home  ${activeCount}` : 'Home',
            browser:   mediaCount  > 0 ? `Browse  ${mediaCount}` : 'Browse',
            library:   allTasks.length > 0 ? `Library  ${allTasks.length}` : 'Library',
            bookmarks: bookmarks.length > 0 ? `Saved  ${bookmarks.length}` : 'Saved',
          };
          const isActive = tab === id;
          return (
            <React.Fragment key={id}>
              {idx > 0 && <View style={[s.tabSep, { backgroundColor: t.sep }]} />}
              <Pressable android_ripple={RIPPLE} style={s.tabItem} onPress={() => setTab(id)}>
                {IS_ANDROID && isActive && <View style={[s.tabPill, { backgroundColor: `${t.btn}12` }]} />}
                <Text style={[s.tabLabel, { color: isActive ? t.ink : t.ink2,
                  fontWeight: isActive ? '600' : '400', fontSize: fs(13) }]}>
                  {labels[id]}
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
              <View style={[s.sheetHead, { backgroundColor: t.bg }]}>
                <Pressable android_ripple={RIPPLE_BL} onPress={() => setPreviewItem(null)} hitSlop={S.sm}>
                  <Text style={[s.sheetBackLabel, { color: t.ink2, fontSize: fs(14) }]}>← Back</Text>
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
                  <View style={[s.metaRow, { borderBottomColor: t.sep }]}>
                    <Text style={[s.metaKey, { color: t.ink2, fontSize: fs(13) }]}>Quality</Text>
                    <Text style={[s.metaVal, { color: t.ink, fontSize: fs(13) }]}>
                      {getQuality(previewItem.url, previewItem.label)}
                    </Text>
                  </View>
                )}
                <View style={[s.metaRow, { borderBottomColor: t.sep }]}>
                  <Text style={[s.metaKey, { color: t.ink2, fontSize: fs(13) }]}>Format</Text>
                  <Text style={[s.metaVal, { color: t.ink, fontSize: fs(13) }]}>
                    {getMediaFormat(previewItem)}
                  </Text>
                </View>

                <Pressable
                  android_ripple={{ color: 'rgba(255,255,255,0.15)', borderless: false }}
                  style={[s.primaryBtn, { backgroundColor: t.btn, marginTop: S.lg }]}
                  onPress={() => handleDetectedDownload(previewItem)}>
                  <Text style={[s.primaryBtnLabel, { color: t.btnTxt, fontSize: fs(16) }]}>
                    Download
                  </Text>
                </Pressable>
              </ScrollView>
            </>
          ) : (
            /* ── Video list ── */
            <>
              <View style={[s.sheetHead, { backgroundColor: t.bg }]}>
                <Text style={[s.sheetTitle, { color: t.ink, fontSize: fs(20) }]}>
                  {mediaCount > 0 ? `${mediaCount} Media Item${mediaCount !== 1 ? 's' : ''} Found` : 'Media'}
                </Text>
                <Pressable android_ripple={RIPPLE_BL}
                  style={[s.closeRound, { backgroundColor: t.card }]}
                  onPress={() => setVideosOpen(false)} hitSlop={S.sm}>
                  <Text style={[s.closeRoundLabel, { color: t.ink2 }]}>✕</Text>
                </Pressable>
              </View>

              <ScrollView style={{ maxHeight: 360 }}
                contentContainerStyle={{ paddingHorizontal: S.md, paddingBottom: S.sm }}
                showsVerticalScrollIndicator={false}>
                {allVideos.length === 0 && !mseActive && (
                  <View style={s.center}>
                    <Text style={[s.emptyHomeText, { color: t.ink2, fontSize: fs(14), textAlign: 'center',
                      paddingVertical: S.xl }]}>
                      Browse to a page with media — it will appear here.
                    </Text>
                  </View>
                )}
                {allVideos.map((item) => {
                  const source  = getSourceName(item.url);
                  const quality = getQuality(item.url, item.label) || getMediaFormat(item);
                  return (
                    <Pressable key={item.id} android_ripple={RIPPLE}
                      style={[s.videoRow, { backgroundColor: t.card, borderBottomColor: t.sep }]}
                      onPress={() => setPreviewItem(item)}>
                      <View style={[s.videoAvatar, { backgroundColor: t.card2 }]}>
                        <Text style={[s.videoAvatarText, { color: t.ink, fontSize: fs(15) }]}>
                          {getInitial(source)}
                        </Text>
                      </View>
                      <View style={s.videoMeta}>
                        <Text style={[s.videoSource, { color: t.ink, fontSize: fs(14) }]}>{source}</Text>
                        {quality && (
                          <Text style={[s.videoQuality, { color: t.ink2, fontSize: fs(12) }]}>{quality}</Text>
                        )}
                      </View>
                      <Pressable android_ripple={RIPPLE}
                        style={[s.dlBtn, { backgroundColor: t.btn }]}
                        onPress={() => handleDetectedDownload(item)}>
                        <Text style={[s.dlBtnLabel, { color: t.btnTxt, fontSize: fs(13) }]}>Download</Text>
                      </Pressable>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {/* Manual paste */}
              <View style={[s.sheetPasteRow, { borderTopColor: t.sep, backgroundColor: t.bg }]}>
                <TextInput
                  style={[s.sheetPasteInput, { backgroundColor: t.card, color: t.ink, fontSize: fs(14) }]}
                  value={pasteUrl}
                  onChangeText={setPasteUrl}
                  placeholder="Paste a media or page URL…"
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
                    {extracting ? '…' : 'Add'}
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      </Modal>

      {/* ── Modals ──────────────────────────────────────── */}
      <SettingsSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)}
        theme={theme} fontSize={fontSize} onThemeChange={setTheme} onFontSizeChange={setFontSize} t={t} />
      {playingPath && <VideoPlayerModal path={playingPath} onClose={() => setPlayingPath(null)} />}
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

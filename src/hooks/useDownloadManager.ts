import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { DetectedMedia, DownloadStatus, DownloadStrategy, DownloadTask } from '../types';
import { deleteDownload } from '../lib/hlsDownloader';
import { DRMProtectedError, pickStrategy, runDownload } from '../lib/downloadStrategies';
import { startDownloadKeepAlive, stopDownloadKeepAlive } from '../lib/downloadKeepAlive';
import { ServerExtractionError } from '../lib/serverExtractor';
import { extractionManager } from '../lib/extractionManager';
import { getMediaGroupKey } from '../lib/mediaHelpers';

const STORAGE_KEY = '@fcdownloader/tasks_v1';
const MAX_AUTO_RETRIES = 2;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function rebasePersistedDownloadPath(
  path?: string,
  platform: typeof Platform.OS = Platform.OS,
): string | undefined {
  if (platform !== 'ios' || !path || !FileSystem.documentDirectory) return path;
  const marker = '/Documents/';
  const markerIndex = path.indexOf(marker);
  if (markerIndex < 0) return path;
  const relativePath = path.slice(markerIndex + marker.length);
  return `${FileSystem.documentDirectory}${relativePath}`;
}

export function isRetryableDownloadError(err: unknown): boolean {
  if (err instanceof DRMProtectedError) return false;
  if (err instanceof ServerExtractionError) {
    return !err.code || !['AUTH_REQUIRED', 'GEO_BLOCKED', 'RATE_LIMITED'].includes(err.code);
  }

  const msg = ((err as Error)?.message || '').toLowerCase();
  if (msg === 'cancelled' || msg.includes('drm-protected')) return false;
  if (/http [234]\d\d|non-media|login|required|geo.?blocked|rate limit|forbidden|unauthorized/.test(msg)) return false;
  return /stalled|truncated|network request failed|network|reset|econnreset|epipe|stream|connection|socket|timeout|timed out|eof|terminated|empty body|http 5\d\d/.test(msg);
}

// ── Reducer ───────────────────────────────────────────────────

type Action =
  | { type: 'HYDRATE'; tasks: DownloadTask[] }
  | { type: 'ADD'; task: DownloadTask }
  | { type: 'UPDATE'; id: string; patch: Partial<DownloadTask> }
  | { type: 'REMOVE'; id: string };

function reducer(state: DownloadTask[], action: Action): DownloadTask[] {
  switch (action.type) {
    case 'HYDRATE': {
      const currentIds = new Set(state.map((task) => task.id));
      return [...state, ...action.tasks.filter((task) => !currentIds.has(task.id))];
    }
    case 'ADD':     return [action.task, ...state];
    case 'UPDATE':  return state.map((t) => t.id === action.id ? { ...t, ...action.patch } : t);
    case 'REMOVE':  return state.filter((t) => t.id !== action.id);
    default:        return state;
  }
}

// ── Hook ──────────────────────────────────────────────────────

interface DownloadManagerOptions {
  onComplete?: (task: DownloadTask) => void;
  onError?: (task: DownloadTask) => void;
}

export function useDownloadManager(options: DownloadManagerOptions = {}) {
  const [tasks, dispatch] = useReducer(reducer, []);
  const controllers = useRef<Map<string, AbortController>>(new Map());
  const activeDownloadKeys = useRef<Set<string>>(new Set());
  const resumedTaskIds = useRef<Set<string>>(new Set());
  const pendingPersistTasks = useRef<DownloadTask[]>([]);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastPersistAt = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const saved: DownloadTask[] = JSON.parse(raw);
        dispatch({
          type: 'HYDRATE',
          tasks: saved
            .filter((t) => t.status !== 'cancelled')
            .map((task) => {
              const localPlaylistPath = rebasePersistedDownloadPath(task.localPlaylistPath);
              const legacyBrowserCompletion =
                Platform.OS === 'web' &&
                task.status === 'completed' &&
                /^https?:\/\//i.test(localPlaylistPath ?? '');
              return {
                ...task,
                status: legacyBrowserCompletion ? 'handed_off' as const : task.status,
                localPlaylistPath,
                completedAt: legacyBrowserCompletion ? undefined : task.completedAt,
                browserHandoffAt: legacyBrowserCompletion
                  ? task.completedAt ?? task.createdAt
                  : task.browserHandoffAt,
              };
            }),
        });
      })
      .catch(() => {})
      .finally(() => {
        setIsHydrated(true);
      });
  }, []);

  useEffect(() => {
    if (!isHydrated) return;
    pendingPersistTasks.current = tasks.filter((t) => t.status !== 'cancelled');

    const persist = () => {
      persistTimer.current = undefined;
      lastPersistAt.current = Date.now();
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(pendingPersistTasks.current)).catch(() => {});
    };

    const elapsed = Date.now() - lastPersistAt.current;
    if (elapsed >= 1_000 && !persistTimer.current) {
      persist();
    } else if (!persistTimer.current) {
      persistTimer.current = setTimeout(persist, Math.max(0, 1_000 - elapsed));
    }
  }, [isHydrated, tasks]);

  const update = useCallback((id: string, patch: Partial<DownloadTask>) => {
    dispatch({ type: 'UPDATE', id, patch });
  }, []);

  const _run = useCallback(
    async (task: DownloadTask): Promise<void> => {
      const { id, strategy } = task;
      const media = { ...task.media };
      if (media.url.startsWith('http://') && !media.url.includes('localhost') && !media.url.includes('127.0.0.1')) {
        media.url = media.url.replace('http://', 'https://');
      }
      if (media.audioTrackUrl && media.audioTrackUrl.startsWith('http://') && !media.audioTrackUrl.includes('localhost') && !media.audioTrackUrl.includes('127.0.0.1')) {
        media.audioTrackUrl = media.audioTrackUrl.replace('http://', 'https://');
      }
      const controller = new AbortController();
      controllers.current.set(id, controller);

      // When a CDN URL expires mid-download (HTTP 403), re-extract the page to
      // get a fresh signed URL.  Only attempted once per download to avoid loops.
      const onTokenExpired = async (expiredUrl: string): Promise<string | null> => {
        try {
          const result = await extractionManager.extract(media.pageUrl);
          if (!result.success || !result.media?.length) return null;
          // Prefer a replacement with the same kind+type, fall back to any fresh URL.
          const fresh =
            result.media.find((m) => m.url !== expiredUrl && m.mediaKind === media.mediaKind && m.mediaType === media.mediaType) ??
            result.media.find((m) => m.url !== expiredUrl && m.mediaKind === media.mediaKind) ??
            result.media.find((m) => m.url !== expiredUrl);
          return fresh?.url ?? null;
        } catch {
          return null;
        }
      };

      try {
        let lastProgressUpdateAt = 0;
        let localPlaylistPath = '';
        for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt += 1) {
          try {
            localPlaylistPath = await runDownload(media, id, strategy, {
              signal: controller.signal,
              onStatus: (status: DownloadStatus, error?: string) => update(id, { status, error }),
              onProgress: (done: number, total: number) => {
                const now = Date.now();
                const isFinalMarker = done === 1 && total === 1;
                if (!isFinalMarker && now - lastProgressUpdateAt < 200) return;
                lastProgressUpdateAt = now;
                update(id, {
                  status: 'downloading',
                  error: undefined,
                  downloadedSegments: done,
                  totalSegments: total,
                  progress: total > 0 ? done / total : 0,
                });
              },
              onTokenExpired,
            });
            break;
          } catch (err) {
            if (controller.signal.aborted || (err as Error).message === 'Cancelled') throw err;
            if (attempt >= MAX_AUTO_RETRIES || !isRetryableDownloadError(err)) throw err;
            update(id, {
              status: 'fetching_manifest',
              error: `Network interrupted — retrying (${attempt + 1}/${MAX_AUTO_RETRIES})`,
            });
            await delay(1_000 * (attempt + 1));
          }
        }

        const isBrowserHandoff = Platform.OS === 'web';
        const finalStatus: DownloadStatus = isBrowserHandoff ? 'handed_off' : 'completed';
        const finishedAt = Date.now();
        const completedTask: DownloadTask = {
          ...task,
          status: finalStatus,
          progress: 1,
          localPlaylistPath,
          completedAt: isBrowserHandoff ? undefined : finishedAt,
          browserHandoffAt: isBrowserHandoff ? finishedAt : undefined,
        };
        update(id, {
          status: finalStatus,
          progress: 1,
          localPlaylistPath,
          completedAt: isBrowserHandoff ? undefined : finishedAt,
          browserHandoffAt: isBrowserHandoff ? finishedAt : undefined,
        });
        optionsRef.current.onComplete?.(completedTask);
      } catch (err) {
        console.error('[useDownloadManager] Download failed:', err);
        const isDRM = err instanceof DRMProtectedError;
        const isCancelled = (err as Error).message === 'Cancelled';
        const errorCode = err instanceof ServerExtractionError ? err.code : undefined;
        const errorMsg = isDRM
          ? 'DRM-protected — cannot download'
          : (err as Error).message;

        const failedTask: DownloadTask = {
          ...task, status: isCancelled ? 'cancelled' : 'failed',
          error: errorMsg, errorCode,
        };
        update(id, { status: failedTask.status, error: errorMsg, errorCode });

        if (!isDRM && !isCancelled) {
          await deleteDownload(id);
          optionsRef.current.onError?.(failedTask);
        }
      } finally {
        controllers.current.delete(id);
        activeDownloadKeys.current.delete(getDownloadDedupeKey(task.media));
      }
    },
    [update],
  );

  useEffect(() => {
    if (!isHydrated) return;
    for (const task of tasks) {
      if (task.status === 'completed' || task.status === 'handed_off' || task.status === 'failed' || task.status === 'cancelled') continue;
      if (resumedTaskIds.current.has(task.id)) continue;

      const dedupeKey = getDownloadDedupeKey(task.media);
      if (activeDownloadKeys.current.has(dedupeKey)) continue;

      resumedTaskIds.current.add(task.id);
      activeDownloadKeys.current.add(dedupeKey);
      const resumedTask: DownloadTask = {
        ...task,
        status: 'pending',
        error: 'Resuming interrupted download',
      };
      update(task.id, resumedTask);
      setTimeout(() => { void _run(resumedTask); }, 0);
    }
  }, [isHydrated, tasks, _run, update]);

  // ── Public API ────────────────────────────────────────────────

  const enqueue = useCallback(
    (media: DetectedMedia, strategyOverride?: DownloadStrategy): boolean => {
      const dedupeKey = getDownloadDedupeKey(media);
      if (activeDownloadKeys.current.has(dedupeKey)) return false;
      const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const strategy = strategyOverride ?? pickStrategy(media);
      activeDownloadKeys.current.add(dedupeKey);
      const task: DownloadTask = {
        id,
        media,
        strategy,
        status: 'pending',
        progress: 0,
        totalSegments: 0,
        downloadedSegments: 0,
        createdAt: Date.now(),
      };
      dispatch({ type: 'ADD', task });
      // Fire-and-forget: the download runs in the background and reports
      // progress via task status (shown in the In-Progress list). Awaiting it
      // must never block the caller or serialize galleries. _run never throws.
      setTimeout(() => { void _run(task); }, 0);
      return true;
    },
    [_run],
  );

  /** Retry a failed task with the same or a different strategy. */
  const retry = useCallback(
    async (taskId: string, strategyOverride?: DownloadStrategy): Promise<void> => {
      const existing = tasks.find((t) => t.id === taskId);
      if (!existing) return;
      const dedupeKey = getDownloadDedupeKey(existing.media);
      if (activeDownloadKeys.current.has(dedupeKey)) return;
      activeDownloadKeys.current.add(dedupeKey);
      // Reuse same id so it replaces in-place in the list
      const strategy = strategyOverride ?? existing.strategy;
      const task: DownloadTask = {
        ...existing,
        strategy,
        status: 'pending',
        progress: 0,
        totalSegments: 0,
        downloadedSegments: 0,
        retryCount: (existing.retryCount ?? 0) + 1,
        error: undefined,
        localPlaylistPath: undefined,
        completedAt: undefined,
        browserHandoffAt: undefined,
      };
      update(taskId, task);
      void _run(task);
    },
    [tasks, _run, update],
  );

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
  }, []);

  const remove = useCallback(
    async (id: string): Promise<void> => {
      cancel(id);
      await deleteDownload(id);
      dispatch({ type: 'REMOVE', id });
    },
    [cancel],
  );

  const active = tasks.filter(
    (t) => t.status !== 'completed' && t.status !== 'handed_off' && t.status !== 'failed' && t.status !== 'cancelled',
  );
  const history = tasks.filter(
    (t) => t.status === 'completed' || t.status === 'handed_off' || t.status === 'failed',
  );

  // Keep the process + a wake lock alive (via an Android foreground service)
  // while any download is running, so backgrounding the app or locking the
  // screen doesn't stall the streaming download loops. Stops once idle.
  // Idle always issues a stop rather than only on a 1->0 transition: a service
  // left running by a previous process (killed mid-download) would otherwise
  // never be torn down. stopService on a dead service is a no-op.
  const activeCount = active.length;
  useEffect(() => {
    if (activeCount > 0) {
      void startDownloadKeepAlive(activeCount);
    } else {
      void stopDownloadKeepAlive();
    }
  }, [activeCount]);

  return { tasks, active, history, enqueue, retry, cancel, remove };
}

function getDownloadDedupeKey(media: DetectedMedia): string {
  return getMediaGroupKey(media) ?? `url_${media.url.split('#')[0]}`;
}

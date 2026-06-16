import { useCallback, useEffect, useReducer, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DetectedMedia, DownloadStatus, DownloadStrategy, DownloadTask } from '../types';
import { deleteDownload } from '../lib/hlsDownloader';
import { DRMProtectedError, pickStrategy, runDownload } from '../lib/downloadStrategies';
import { ServerExtractionError } from '../lib/serverExtractor';
import { extractionManager } from '../lib/extractionManager';

const STORAGE_KEY = '@fcdownloader/tasks_v1';

// ── Reducer ───────────────────────────────────────────────────

type Action =
  | { type: 'HYDRATE'; tasks: DownloadTask[] }
  | { type: 'ADD'; task: DownloadTask }
  | { type: 'UPDATE'; id: string; patch: Partial<DownloadTask> }
  | { type: 'REMOVE'; id: string };

function reducer(state: DownloadTask[], action: Action): DownloadTask[] {
  switch (action.type) {
    case 'HYDRATE': return action.tasks;
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
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const saved: DownloadTask[] = JSON.parse(raw);
        dispatch({
          type: 'HYDRATE',
          tasks: saved.filter((t) => t.status === 'completed' || t.status === 'failed'),
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const saveable = tasks.filter((t) => t.status === 'completed' || t.status === 'failed');
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(saveable)).catch(() => {});
  }, [tasks]);

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
        const localPlaylistPath = await runDownload(media, id, strategy, {
          signal: controller.signal,
          onStatus: (status: DownloadStatus, error?: string) => update(id, { status, error }),
          onProgress: (done: number, total: number) =>
            update(id, {
              status: 'downloading',
              downloadedSegments: done,
              totalSegments: total,
              progress: total > 0 ? done / total : 0,
            }),
          onTokenExpired,
        });

        const completedTask: DownloadTask = {
          ...task,
          status: 'completed',
          progress: 1,
          localPlaylistPath,
          completedAt: Date.now(),
        };
        update(id, {
          status: 'completed',
          progress: 1,
          localPlaylistPath,
          completedAt: Date.now(),
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
      }
    },
    [update],
  );

  // ── Public API ────────────────────────────────────────────────

  const enqueue = useCallback(
    async (media: DetectedMedia, strategyOverride?: DownloadStrategy): Promise<void> => {
      const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const strategy = strategyOverride ?? pickStrategy(media);
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
      // here would block the caller — keeping the Home "Finding…" button stuck
      // for the whole download and serializing galleries. _run never throws.
      void _run(task);
    },
    [_run],
  );

  /** Retry a failed task with the same or a different strategy. */
  const retry = useCallback(
    async (taskId: string, strategyOverride?: DownloadStrategy): Promise<void> => {
      const existing = tasks.find((t) => t.id === taskId);
      if (!existing) return;
      // Reuse same id so it replaces in-place in the list
      const strategy = strategyOverride ?? existing.strategy;
      const task: DownloadTask = {
        ...existing,
        strategy,
        status: 'pending',
        progress: 0,
        totalSegments: 0,
        downloadedSegments: 0,
        error: undefined,
        localPlaylistPath: undefined,
        completedAt: undefined,
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
    (t) => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled',
  );
  const history = tasks.filter(
    (t) => t.status === 'completed' || t.status === 'failed',
  );

  return { tasks, active, history, enqueue, retry, cancel, remove };
}

import { useCallback, useEffect, useReducer, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DetectedMedia, DownloadStatus, DownloadStrategy, DownloadTask } from '../types';
import { deleteDownload } from '../lib/hlsDownloader';
import { DRMProtectedError, pickStrategy, runDownload } from '../lib/downloadStrategies';

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

  // ── Core runner — shared by enqueue and retry ────────────────
  const _run = useCallback(
    async (task: DownloadTask): Promise<void> => {
      const { id, media, strategy } = task;
      const controller = new AbortController();
      controllers.current.set(id, controller);

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
        const isDRM = err instanceof DRMProtectedError;
        const isCancelled = (err as Error).message === 'Cancelled';
        const errorMsg = isDRM
          ? 'DRM-protected — cannot download'
          : (err as Error).message;

        const failedTask: DownloadTask = { ...task, status: isCancelled ? 'cancelled' : 'failed', error: errorMsg };
        update(id, { status: failedTask.status, error: errorMsg });

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
      await _run(task);
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
      await _run(task);
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

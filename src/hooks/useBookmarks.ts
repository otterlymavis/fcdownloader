import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@fcdownloader/bookmarks_v1';

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  timestamp: number;
}

export function useBookmarks() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => { if (raw) setBookmarks(JSON.parse(raw)); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(KEY, JSON.stringify(bookmarks)).catch(() => {});
  }, [bookmarks]);

  const toggle = useCallback((url: string, title: string) => {
    setBookmarks((prev) => {
      if (prev.some((b) => b.url === url)) return prev.filter((b) => b.url !== url);
      return [{ id: `bm_${Date.now()}`, url, title, timestamp: Date.now() }, ...prev];
    });
  }, []);

  const remove = useCallback((id: string) => {
    setBookmarks((prev) => prev.filter((b) => b.id !== id));
  }, []);

  const isSaved = useCallback((url: string, bms: Bookmark[]) =>
    bms.some((b) => b.url === url), []);

  return { bookmarks, toggle, remove, isSaved };
}

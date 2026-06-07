import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemePref    = 'system' | 'light' | 'dark';
export type FontSizePref = 'small' | 'medium' | 'large';

export const FONT_SCALE: Record<FontSizePref, number> = {
  small:  0.88,
  medium: 1.0,
  large:  1.18,
};

interface Settings {
  theme:    ThemePref;
  fontSize: FontSizePref;
}

const DEFAULT: Settings = { theme: 'system', fontSize: 'medium' };
const KEY = '@fcdownloader/settings_v1';

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => { if (raw) setSettings({ ...DEFAULT, ...JSON.parse(raw) }); })
      .catch(() => {});
  }, []);

  const save = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  return {
    theme:         settings.theme,
    fontSize:      settings.fontSize,
    fontScale:     FONT_SCALE[settings.fontSize],
    setTheme:      (v: ThemePref)    => save({ theme: v }),
    setFontSize:   (v: FontSizePref) => save({ fontSize: v }),
  };
}

import { Platform, StatusBar, useColorScheme } from 'react-native';

export const TOP_PAD = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 0;
export const BOTTOM_PAD = Platform.OS === 'android' ? 16 : 0;
export const IS_IOS = Platform.OS === 'ios';
export const IS_ANDROID = Platform.OS === 'android';

export const RIPPLE = IS_ANDROID ? { color: 'rgba(0,0,0,0.06)', borderless: false } : undefined;
export const RIPPLE_BL = IS_ANDROID ? { color: 'rgba(0,0,0,0.06)', borderless: true } : undefined;

export const S = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
export const R = { sm: 8, md: 12, lg: 16, xl: 20 } as const;

const LIGHT = {
  bg: '#FFFFFF',
  card: '#F5F5F5',
  card2: '#EBEBEB',
  sep: '#E8E8E8',
  ink: '#1A1A1A',
  ink2: '#8A8A8A',
  ink3: '#C0C0C0',
  btn: '#1A1A1A',
  btnTxt: '#FFFFFF',
  red: '#C0392B',
  redBg: '#FDF2F2',
} as const;

const DARK = {
  bg: '#0D0D0D',
  card: '#1A1A1A',
  card2: '#252525',
  sep: '#2A2A2A',
  ink: '#F2F2F2',
  ink2: '#888888',
  ink3: '#404040',
  btn: '#F2F2F2',
  btnTxt: '#0D0D0D',
  red: '#E05A5A',
  redBg: '#2A1515',
} as const;

export function useTheme(darkOverride?: boolean) {
  const systemDark = useColorScheme() === 'dark';
  const dark = darkOverride ?? systemDark;
  const colors = dark ? DARK : LIGHT;
  return {
    ...colors,
    dark,
    ripple: dark ? { color: 'rgba(255,255,255,0.06)', borderless: false } : RIPPLE,
  };
}

export const subtleShadow = IS_IOS
  ? { shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } }
  : { elevation: 1 };

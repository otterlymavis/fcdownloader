import { Platform, StatusBar, useColorScheme } from 'react-native';

export const TOP_PAD = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 0;
export const BOTTOM_PAD = Platform.OS === 'android' ? 16 : 0;
export const IS_IOS = Platform.OS === 'ios';
export const IS_ANDROID = Platform.OS === 'android';

export const RIPPLE = IS_ANDROID ? { color: 'rgba(0,0,0,0.06)', borderless: false } : undefined;
export const RIPPLE_BL = IS_ANDROID ? { color: 'rgba(0,0,0,0.06)', borderless: true } : undefined;

export const S = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
export const R = { sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 } as const;

// ── V3 static background colors ──────────────────────────────────
// Light: soft lavender-to-blush gradient (simulated with a solid + radial overlay)
export const BG_LIGHT = '#FFFFFF';
export const BG_DARK  = '#000000';

// ── V3 Card / glass tokens ────────────────────────────────────────
export const GLASS_DARK = {
  cardBg:       'rgba(255,255,255,0.08)',
  cardBorder:   'rgba(255,255,255,0.14)',
  inputBg:      'rgba(255,255,255,0.10)',
  tabBg:        'rgba(15,15,15,0.88)',
  tabBorder:    'rgba(255,255,255,0.10)',
  pillActive:   '#FFFFFF',
  pillActiveTxt:'#09071A',
} as const;

export const GLASS_LIGHT = {
  cardBg:       'rgba(255,255,255,0.72)',
  cardBorder:   'rgba(255,255,255,0.90)',
  inputBg:      'rgba(255,255,255,0.80)',
  tabBg:        'rgba(250,250,250,0.85)',
  tabBorder:    'rgba(0,0,0,0.06)',
  pillActive:   '#1A1A2E',
  pillActiveTxt:'#FFFFFF',
} as const;

const LIGHT = {
  bg:       BG_LIGHT,
  bgGrad:   ['#FFFFFF', '#FFFFFF', '#FFFFFF'],
  card:     'rgba(255,255,255,0.72)',
  card2:    'rgba(255,255,255,0.50)',
  sep:      'rgba(0,0,0,0.07)',
  ink:      '#1A1A2E',
  ink2:     '#6B7280',
  ink3:     'rgba(0,0,0,0.22)',
  btn:      '#1A1A2E',
  btnTxt:   '#FFFFFF',
  red:      '#C0392B',
  redBg:    'rgba(192,57,43,0.08)',
  progress: '#5B5BD6',
  green:    '#22C55E',
  greenBg:  'rgba(34,197,94,0.12)',
} as const;

const DARK = {
  bg:       BG_DARK,
  bgGrad:   ['#000000', '#000000', '#000000'],
  card:     'rgba(255,255,255,0.08)',
  card2:    'rgba(255,255,255,0.05)',
  sep:      'rgba(255,255,255,0.14)',
  ink:      '#FFFFFF',
  ink2:     'rgba(255,255,255,0.55)',
  ink3:     'rgba(255,255,255,0.20)',
  btn:      '#FFFFFF',
  btnTxt:   '#09071A',
  red:      '#E05A5A',
  redBg:    'rgba(224,90,90,0.12)',
  progress: '#A78BFA',
  green:    '#4ADE80',
  greenBg:  'rgba(74,222,128,0.12)',
} as const;

export function useTheme(darkOverride?: boolean) {
  const systemDark = useColorScheme() === 'dark';
  const dark = darkOverride ?? systemDark;
  const colors = dark ? DARK : LIGHT;
  return {
    ...colors,
    dark,
    glass: dark ? GLASS_DARK : GLASS_LIGHT,
    ripple: dark ? { color: 'rgba(255,255,255,0.06)', borderless: false } : RIPPLE,
  };
}

export const subtleShadow = IS_IOS
  ? { shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 10, shadowOffset: { width: 0, height: 3 } }
  : { elevation: 2 };

export const glassShadow = IS_IOS
  ? { shadowColor: '#000', shadowOpacity: 0.10, shadowRadius: 14, shadowOffset: { width: 0, height: 5 } }
  : { elevation: 3 };

/**
 * Common locale profiles for extraction requests.
 *
 * These are not UI translations. They keep fetches and player API requests
 * aligned with the user's language or the target site's region when a site
 * serves different markup/manifests by Accept-Language.
 */

export type CommonLanguageCode =
  | 'en'
  | 'es'
  | 'fr'
  | 'de'
  | 'pt'
  | 'it'
  | 'ja'
  | 'ko'
  | 'zh'
  | 'zh-hant'
  | 'hi'
  | 'ar'
  | 'id'
  | 'ru'
  | 'tr'
  | 'vi'
  | 'th';

type LanguageProfile = {
  acceptLanguage: string;
  youtube: {
    hl: string;
    gl: string;
  };
};

export const COMMON_LANGUAGE_PROFILES: Record<CommonLanguageCode, LanguageProfile> = {
  en: {
    acceptLanguage: 'en-US,en;q=0.9',
    youtube: { hl: 'en', gl: 'US' },
  },
  es: {
    acceptLanguage: 'es-ES,es;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'es', gl: 'ES' },
  },
  fr: {
    acceptLanguage: 'fr-FR,fr;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'fr', gl: 'FR' },
  },
  de: {
    acceptLanguage: 'de-DE,de;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'de', gl: 'DE' },
  },
  pt: {
    acceptLanguage: 'pt-BR,pt;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'pt', gl: 'BR' },
  },
  it: {
    acceptLanguage: 'it-IT,it;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'it', gl: 'IT' },
  },
  ja: {
    acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'ja', gl: 'JP' },
  },
  ko: {
    acceptLanguage: 'ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'ko', gl: 'KR' },
  },
  zh: {
    acceptLanguage: 'zh-CN,zh;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'zh-CN', gl: 'CN' },
  },
  'zh-hant': {
    acceptLanguage: 'zh-TW,zh;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'zh-TW', gl: 'TW' },
  },
  hi: {
    acceptLanguage: 'hi-IN,hi;q=0.9,en-US;q=0.7,en;q=0.6',
    youtube: { hl: 'hi', gl: 'IN' },
  },
  ar: {
    acceptLanguage: 'ar-SA,ar;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'ar', gl: 'SA' },
  },
  id: {
    acceptLanguage: 'id-ID,id;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'id', gl: 'ID' },
  },
  ru: {
    acceptLanguage: 'ru-RU,ru;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'ru', gl: 'RU' },
  },
  tr: {
    acceptLanguage: 'tr-TR,tr;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'tr', gl: 'TR' },
  },
  vi: {
    acceptLanguage: 'vi-VN,vi;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'vi', gl: 'VN' },
  },
  th: {
    acceptLanguage: 'th-TH,th;q=0.9,en-US;q=0.6,en;q=0.5',
    youtube: { hl: 'th', gl: 'TH' },
  },
};

const TLD_LANGUAGE: Record<string, CommonLanguageCode> = {
  jp: 'ja',
  kr: 'ko',
  cn: 'zh',
  tw: 'zh-hant',
  hk: 'zh-hant',
  mo: 'zh-hant',
  in: 'hi',
  id: 'id',
  br: 'pt',
  pt: 'pt',
  es: 'es',
  mx: 'es',
  co: 'es',
  ar: 'es',
  cl: 'es',
  pe: 'es',
  fr: 'fr',
  de: 'de',
  it: 'it',
  sa: 'ar',
  ae: 'ar',
  eg: 'ar',
  qa: 'ar',
  kw: 'ar',
  bh: 'ar',
  om: 'ar',
  jo: 'ar',
  ma: 'ar',
  dz: 'ar',
  tn: 'ar',
  ru: 'ru',
  tr: 'tr',
  vn: 'vi',
  th: 'th',
};

const HOST_LANGUAGE: Record<string, CommonLanguageCode> = {
  'bilibili.com': 'zh',
  'b23.tv': 'zh',
  'weibo.com': 'zh',
  'weibo.cn': 'zh',
  'xiaohongshu.com': 'zh',
  'xhslink.com': 'zh',
  'nicovideo.jp': 'ja',
  'nico.ms': 'ja',
  'niconico.com': 'ja',
  'nicochannel.jp': 'ja',
  'tver.jp': 'ja',
  'abema.tv': 'ja',
  'nhk.or.jp': 'ja',
  'nhk.jp': 'ja',
  'wwdjapan.com': 'ja',
  'wwd.co.jp': 'ja',
  'openrec.tv': 'ja',
  'twitcasting.tv': 'ja',
  'mildom.com': 'ja',
  'ameba.jp': 'ja',
  'ameblo.jp': 'ja',
  'fc2.com': 'ja',
  'fujitv.co.jp': 'ja',
  'tbs.co.jp': 'ja',
  'tbs.jp': 'ja',
};

export function normalizeLanguageTag(tag?: string | null): CommonLanguageCode | undefined {
  const normalized = String(tag ?? '').trim().replace(/_/g, '-').toLowerCase();
  if (!normalized) return undefined;
  if (/^zh-(tw|hk|mo|hant)/.test(normalized)) return 'zh-hant';
  const primary = normalized.split('-', 1)[0] as CommonLanguageCode;
  return primary in COMMON_LANGUAGE_PROFILES ? primary : undefined;
}

export function acceptLanguageForTags(tags?: readonly (string | null | undefined)[], fallback = COMMON_LANGUAGE_PROFILES.en.acceptLanguage): string {
  for (const tag of tags ?? []) {
    const code = normalizeLanguageTag(tag);
    if (code) return COMMON_LANGUAGE_PROFILES[code].acceptLanguage;
  }
  return fallback;
}

export function acceptLanguageForUrl(url: string, fallback = COMMON_LANGUAGE_PROFILES.en.acceptLanguage): string {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return fallback;
  }
  for (const [suffix, code] of Object.entries(HOST_LANGUAGE)) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      return COMMON_LANGUAGE_PROFILES[code].acceptLanguage;
    }
  }
  const tld = host.split('.').pop() ?? '';
  const code = TLD_LANGUAGE[tld];
  return code ? COMMON_LANGUAGE_PROFILES[code].acceptLanguage : fallback;
}

export function youtubeLocaleForTags(tags?: readonly (string | null | undefined)[]): LanguageProfile['youtube'] {
  for (const tag of tags ?? []) {
    const code = normalizeLanguageTag(tag);
    if (code) return COMMON_LANGUAGE_PROFILES[code].youtube;
  }
  return COMMON_LANGUAGE_PROFILES.en.youtube;
}

export function runtimeLanguageTags(): string[] {
  const nav = (globalThis as any)?.navigator;
  const navLanguages = Array.isArray(nav?.languages) ? nav.languages.filter(Boolean) : [];
  const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
  return [...navLanguages, nav?.language, resolved].filter(Boolean);
}

import { Platform } from 'react-native';

type NativeCookie = {
  name: string;
  value: string;
  domain?: string;
};

type NativeCookieManager = {
  get: (url: string, useWebKit?: boolean) => Promise<Record<string, NativeCookie>>;
  getAll: (useWebKit?: boolean) => Promise<Record<string, NativeCookie>>;
  set: (url: string, cookie: Record<string, unknown>, useWebKit?: boolean) => Promise<boolean>;
};

declare const require: (moduleName: string) => { default?: NativeCookieManager } & NativeCookieManager;

function getCookieManager(): NativeCookieManager | null {
  if (Platform.OS === 'web') return null;
  const mod = require('@react-native-cookies/cookies');
  return mod.default ?? mod;
}

function cookieHeaderFromMap(cookies: Record<string, NativeCookie>): string {
  return Object.values(cookies)
    .filter((c) => c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

async function mergedCookieHeader(urls: string[], domains: string[] = []): Promise<string> {
  const CookieManager = getCookieManager();
  if (!CookieManager) return '';

  const byName = new Map<string, string>();
  for (const url of urls) {
    try {
      const cookies = await CookieManager.get(url, true);
      for (const cookie of Object.values(cookies)) byName.set(cookie.name, cookie.value);
    } catch {}
  }
  if (domains.length > 0) {
    try {
      const all = await CookieManager.getAll(true);
      for (const cookie of Object.values(all)) {
        const cd = (cookie.domain ?? '').replace(/^\./, '');
        if (domains.some((domain) => cd === domain || cd.endsWith(`.${domain}`))) {
          byName.set(cookie.name, cookie.value);
        }
      }
    } catch {}
  }
  return Array.from(byName, ([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Returns cookies for the given URL as a Cookie header string.
 * Uses per-URL lookup first (most accurate), falls back to getAll() with
 * domain filtering if the URL-specific call fails.
 */
export async function extractSessionCookies(url: string): Promise<string> {
  const CookieManager = getCookieManager();
  if (!CookieManager) return '';

  if (/(?:youtube\.com|youtu\.be|googlevideo\.com)/i.test(url)) {
    const header = await mergedCookieHeader(
      ['https://www.youtube.com/', 'https://youtube.com/'],
      ['youtube.com'],
    );
    if (header) return header;
  }

  if (/(?:xiaohongshu\.com|rednote\.com|xhscdn\.com|xhslink\.com)/i.test(url)) {
    const header = await mergedCookieHeader(
      [
        'https://www.xiaohongshu.com/',
        'https://xiaohongshu.com/',
        'https://www.rednote.com/',
        'https://rednote.com/',
      ],
      ['xiaohongshu.com', 'rednote.com'],
    );
    if (header) return header;
  }

  // Try URL-specific lookup first — most reliable on both iOS and Android
  try {
    const cookies = await CookieManager.get(url, true);
    const header = cookieHeaderFromMap(cookies);
    if (header) return header;
  } catch {}

  // Fallback: scan all cookies and filter by domain
  try {
    const domain = new URL(url).hostname;
    const all = await CookieManager.getAll(true);
    return Object.values(all)
      .filter((c) => {
        const cd = (c.domain ?? '').replace(/^\./, '');
        return domain.endsWith(cd) || cd.endsWith(domain);
      })
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  } catch {}

  return '';
}

/**
 * Copies Weibo cookies from WKHTTPCookieStore to NSHTTPCookieStorage.shared so
 * that React Native's fetch() (which uses NSURLSession and ignores manually set
 * Cookie headers) sends the visitor SUB cookie when hitting Weibo APIs.
 */
export async function syncWeiboSessionToNative(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const CookieManager = getCookieManager();
  if (!CookieManager?.set) return;
  try {
    const all = await CookieManager.getAll(true); // WKHTTPCookieStore
    const weiboCookies = Object.values(all).filter(
      (c) => (c.domain ?? '').replace(/^\./, '').endsWith('weibo.cn'),
    );
    for (const cookie of weiboCookies) {
      const cookieObj: Record<string, unknown> = { ...cookie };
      // Set for both m.weibo.cn and weibo.com (domain .weibo.cn covers both)
      for (const url of ['https://m.weibo.cn/', 'https://weibo.com/']) {
        try { await CookieManager.set(url, cookieObj, false); } catch {}
      }
    }
  } catch {}
}

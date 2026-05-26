import CookieManager from '@react-native-cookies/cookies';

type CookieRecord = Awaited<ReturnType<typeof CookieManager.get>>;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isSameSiteCookie(cookieDomain: string | undefined, host: string): boolean {
  const cd = (cookieDomain ?? '').replace(/^\./, '').replace(/^www\./, '');
  if (!cd) return false;
  return host === cd || host.endsWith(`.${cd}`) || cd.endsWith(`.${host}`);
}

function relatedCookieHosts(host: string): string[] {
  if (host.endsWith('youtube.com')) {
    return ['youtube.com'];
  }

  if (
    host.endsWith('xiaohongshu.com') ||
    host.endsWith('xhslink.com') ||
    host.endsWith('xhscdn.com')
  ) {
    return ['xiaohongshu.com', 'xhslink.com', 'xhscdn.com'];
  }

  return [host];
}

function mergeCookies(target: Map<string, string>, cookies: CookieRecord): void {
  Object.values(cookies).forEach((cookie) => {
    if (cookie.name && cookie.value) target.set(cookie.name, cookie.value);
  });
}

/**
 * Returns cookies for the given URL as a Cookie header string.
 * Merges per-URL and domain-wide cookies so mobile YouTube sessions are not
 * lost when the current page is on m.youtube.com but extraction probes www.
 */
export async function extractSessionCookies(url: string): Promise<string> {
  const merged = new Map<string, string>();
  const host = hostOf(url);
  const urls = new Set([url]);

  if (host.endsWith('youtube.com')) {
    urls.add('https://www.youtube.com/');
    urls.add('https://m.youtube.com/');
    urls.add('https://youtube.com/');
  }

  if (
    host.endsWith('xiaohongshu.com') ||
    host.endsWith('xhslink.com') ||
    host.endsWith('xhscdn.com')
  ) {
    urls.add('https://www.xiaohongshu.com/');
    urls.add('https://xiaohongshu.com/');
    urls.add('https://xhslink.com/');
  }

  // URL-specific lookup is reliable, but it can miss cookies stored on a
  // sibling mobile/desktop host.
  for (const candidate of urls) {
    try {
      mergeCookies(merged, await CookieManager.get(candidate, true));
    } catch {}
  }

  // Add domain-wide cookies, including HttpOnly auth cookies where exposed by
  // the native cookie store.
  try {
    const all = await CookieManager.getAll(true);
    const relatedHosts = relatedCookieHosts(host);
    Object.values(all)
      .filter((cookie) => relatedHosts.some((relatedHost) => isSameSiteCookie(cookie.domain, relatedHost)))
      .forEach((cookie) => {
        if (cookie.name && cookie.value) merged.set(cookie.name, cookie.value);
      });
  } catch {}

  return Array.from(merged, ([name, value]) => `${name}=${value}`).join('; ');
}

export async function clearAllCookies(): Promise<void> {
  await CookieManager.clearAll(true);
}

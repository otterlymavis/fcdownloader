import CookieManager from '@react-native-cookies/cookies';

/**
 * Returns cookies for the given URL as a Cookie header string.
 * Uses per-URL lookup first (most accurate), falls back to getAll() with
 * domain filtering if the URL-specific call fails.
 */
export async function extractSessionCookies(url: string): Promise<string> {
  // Try URL-specific lookup first — most reliable on both iOS and Android
  try {
    const cookies = await CookieManager.get(url, true);
    const header = Object.values(cookies)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
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

export async function clearAllCookies(): Promise<void> {
  await CookieManager.clearAll(true);
}

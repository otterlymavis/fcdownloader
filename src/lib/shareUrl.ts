export function extractFirstUrl(text: string): string {
  const match = text.match(/https?:\/\/[^\s<>"'`\\]+/i);
  return (match?.[0] ?? text).trim().replace(/[.,;:!?)\]}>'"]+$/, '');
}

function decodeQueryValue(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function getQueryParam(value: unknown): string | null {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : null;
  return value == null ? null : String(value);
}

export function extractSharedUrlFromDeepLink(
  raw: string,
  params: Record<string, unknown> | null | undefined,
): string | null {
  const candidates = [
    getQueryParam(params?.url),
    getQueryParam(params?.text),
    getQueryParam(params?.link),
  ];

  // Older share-extension builds encoded the shared URL with urlQueryAllowed,
  // which can leave "&" unescaped. Recover the full tail after url=.
  const rawUrlParam = raw.match(/[?&]url=([^#]+)/i)?.[1];
  if (rawUrlParam) candidates.unshift(decodeQueryValue(rawUrlParam));

  for (const candidate of candidates) {
    if (!candidate) continue;
    const url = extractFirstUrl(decodeQueryValue(candidate));
    if (/^https?:\/\//i.test(url)) return url;
  }

  return null;
}

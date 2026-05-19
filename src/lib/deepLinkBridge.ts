import * as Linking from 'expo-linking';

export interface HandoffPayload {
  mediaUrl: string;
  cookies?: string;
  userAgent?: string;
  title?: string;
}

type KnownApp = 'vlc' | 'infuse' | 'nplayer' | 'custom';

const SCHEME_BUILDERS: Record<
  Exclude<KnownApp, 'custom'>,
  (p: HandoffPayload) => string
> = {
  vlc: (p) => `vlc://${encodeURIComponent(p.mediaUrl)}`,
  infuse: (p) =>
    `infuse://x-callback-url/play?url=${encodeURIComponent(p.mediaUrl)}`,
  nplayer: (p) => `nplayer-${encodeURIComponent(p.mediaUrl)}`,
};

function buildCustomUrl(scheme: string, p: HandoffPayload): string {
  const params = new URLSearchParams({ url: p.mediaUrl });
  if (p.cookies) params.set('cookies', p.cookies);
  if (p.userAgent) params.set('userAgent', p.userAgent);
  if (p.title) params.set('title', p.title);
  return `${scheme}://open?${params.toString()}`;
}

/**
 * Opens a locally installed media app via deep link.
 * Returns false gracefully if the app is not installed rather than throwing.
 *
 * Requires LSApplicationQueriesSchemes in app.config.ts:
 *   LSApplicationQueriesSchemes: ['vlc', 'infuse', 'nplayer']
 */
export async function handoffToExternalApp(
  app: KnownApp,
  payload: HandoffPayload,
  customScheme?: string
): Promise<boolean> {
  let url: string;

  if (app === 'custom') {
    if (!customScheme) return false;
    url = buildCustomUrl(customScheme, payload);
  } else {
    url = SCHEME_BUILDERS[app](payload);
  }

  try {
    const canOpen = await Linking.canOpenURL(url);
    if (!canOpen) return false;
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

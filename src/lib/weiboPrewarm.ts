import { DeviceEventEmitter, Platform } from 'react-native';
import { debugLog } from './releaseLogger';

let _resolve: ((ok: boolean) => void) | null = null;
let _pending: Promise<boolean> | null = null;
let _fetchResolve: ((data: unknown) => void) | null = null;

/**
 * Triggers a hidden WKWebView to load m.weibo.cn, executing the Sina Visitor
 * System JavaScript that grants anonymous access. Returns true when the visitor
 * session is established (cookies are in WKHTTPCookieStore), false on timeout
 * or non-iOS platforms. The caller can then retry extractViaServer, which will
 * naturally pick up the new visitor cookies via extractSessionCookies().
 *
 * Uses DeviceEventEmitter ('weibo:prewarm:start' / 'weibo:prewarm:cancel') so
 * the trigger survives Metro HMR module re-evaluation, unlike a module-level
 * _trigger callback that resets to null on every hot update.
 */
export async function prewarmWeiboVisitorSession(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  if (_pending) return _pending;
  debugLog('[weiboPrewarm] starting prewarm');
  _pending = new Promise<boolean>((resolve) => {
    _resolve = resolve;
    DeviceEventEmitter.emit('weibo:prewarm:start');
    setTimeout(() => {
      if (_resolve) {
        debugLog('[weiboPrewarm] timeout after 20s');
        _resolve(false);
        _resolve = null;
        DeviceEventEmitter.emit('weibo:prewarm:cancel');
      }
    }, 20_000);
  });
  try {
    return await _pending;
  } finally {
    _pending = null;
  }
}

export function signalWeiboPrewarmComplete(success: boolean): void {
  if (_resolve) {
    _resolve(success);
    _resolve = null;
    if (!success) DeviceEventEmitter.emit('weibo:prewarm:cancel');
  }
}

/**
 * Called from platformExtractors after prewarm succeeds. Emits weibo:fetch:start
 * so App.tsx injects fetch() into the still-live WKWebView (which holds the visitor
 * SUB cookie). Resolves with the parsed API JSON or null on timeout / network error.
 * This bypasses NSURLSession's cookie handling entirely.
 */
export async function fetchWeiboStatuses(apiUrl: string): Promise<unknown> {
  if (Platform.OS !== 'ios') return null;
  return new Promise<unknown>((resolve) => {
    _fetchResolve = resolve;
    DeviceEventEmitter.emit('weibo:fetch:start', apiUrl);
    setTimeout(() => {
      if (_fetchResolve) {
        debugLog('[weiboPrewarm] fetchWeiboStatuses timeout for', apiUrl);
        _fetchResolve(null);
        _fetchResolve = null;
      }
    }, 15_000);
  });
}

export function signalWeiboFetchComplete(data: unknown): void {
  if (_fetchResolve) {
    _fetchResolve(data);
    _fetchResolve = null;
  }
}

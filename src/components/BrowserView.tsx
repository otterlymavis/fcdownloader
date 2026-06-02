import React, { forwardRef } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import WebView, {
  WebViewMessageEvent,
  WebViewNavigation,
  WebViewProps,
} from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { INJECTED_SCRIPT } from '../constants/injectedScript';

// No "wv" tag — Vimeo and other sites block playback when they detect a WebView UA
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const XHS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

interface Props extends Partial<WebViewProps> {
  initialUrl: string;
  onMessage: (e: WebViewMessageEvent) => void;
  onNavigationChange?: (url: string) => void;
  onExtractPage?: (url: string) => void;
  desktopMode?: boolean;
}

function isXhsUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /(?:^|\.)(?:xiaohongshu|rednote)\.com$/i.test(host) || /(?:^|\.)xhslink\.com$/i.test(host);
  } catch {
    return false;
  }
}

const BrowserView = forwardRef<WebView, Props>(
  (
    { initialUrl, onMessage, onNavigationChange, onExtractPage, desktopMode = false, style, ...rest },
    ref
  ) => {
    const handleNavStateChange = (state: WebViewNavigation) => {
      if (onNavigationChange && state.url) onNavigationChange(state.url);
    };

    // XHS (and WeChat/Weibo) push an "open in app" redirect to a custom scheme
    // — xhsdiscover://, weixin://, sinaweibo://, intent://… Android WebView has
    // no handler for these and aborts the whole page with ERR_UNKNOWN_URL_SCHEME,
    // which is why XHS links "can't open". We only ever want to render web pages
    // here, so block every non-web scheme and stay put on the loaded content —
    // which is also exactly what Scan/Extract needs. iOS WebView ignores these
    // schemes silently, so this is effectively an Android fix.
    const handleShouldStart = (request: ShouldStartLoadRequest): boolean =>
      /^(?:https?|about|data|blob):/i.test(request.url || '');
    const ua = isXhsUrl(initialUrl) ? XHS_UA : desktopMode ? DESKTOP_UA : MOBILE_UA;
    const reload = () => {
      if (typeof ref !== 'function') ref?.current?.reload();
    };

    return (
      <WebView
        ref={ref}
        style={[styles.root, style]}
        source={{ uri: initialUrl }}
        // Inject into EVERY frame including iframes (critical for embedded players)
        // Both props together: "before" for early interception, "after" as Android fallback
        injectedJavaScriptBeforeContentLoaded={INJECTED_SCRIPT}
        injectedJavaScript={INJECTED_SCRIPT}
        injectedJavaScriptForMainFrameOnly={false}
        javaScriptEnabled
        onMessage={onMessage}
        // Cookies — persist in WKHTTPCookieStore / Android CookieManager.
        // sharedCookiesEnabled is intentionally OFF: it would sync WKWebView cookies into
        // NSHTTPCookieStorage.shared, which NSURLSession (used by createDownloadResumable)
        // then auto-attaches to every CDN request, causing HTTP 413 on googlevideo.com.
        thirdPartyCookiesEnabled
        domStorageEnabled
        cacheEnabled
        cacheMode="LOAD_DEFAULT"
        // Media
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsFullscreenVideo
        // User-agent
        userAgent={ua}
        // Navigation
        onNavigationStateChange={handleNavStateChange}
        onShouldStartLoadWithRequest={handleShouldStart}
        onLoadStart={(e) => onNavigationChange?.(e.nativeEvent.url)}
        renderError={(_domain, code, description) => (
          <View style={styles.errorRoot}>
            <Text style={styles.errorTitle}>Page could not load</Text>
            <Text style={styles.errorText} numberOfLines={3}>
              {description || `WebView error ${code}`}
            </Text>
            {isXhsUrl(initialUrl) && (
              <Text style={styles.errorHint}>
                XHS/rednote sometimes blocks Android WebView. You can still extract from the URL or open it in your browser.
              </Text>
            )}
            <View style={styles.errorActions}>
              <Pressable style={styles.errorButton} onPress={reload}>
                <Text style={styles.errorButtonText}>Retry</Text>
              </Pressable>
              <Pressable style={styles.errorButton} onPress={() => onExtractPage?.(initialUrl)}>
                <Text style={styles.errorButtonText}>Extract</Text>
              </Pressable>
              <Pressable style={styles.errorButton} onPress={() => Linking.openURL(initialUrl).catch(() => {})}>
                <Text style={styles.errorButtonText}>Open</Text>
              </Pressable>
            </View>
          </View>
        )}
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled
        {...rest}
      />
    );
  }
);

BrowserView.displayName = 'BrowserView';
export default BrowserView;

const styles = StyleSheet.create({
  root: { flex: 1 },
  errorRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#f8fafc',
  },
  errorTitle: {
    color: '#111827',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  errorText: {
    color: '#4b5563',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    marginBottom: 10,
  },
  errorHint: {
    color: '#6b7280',
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    marginBottom: 16,
  },
  errorActions: {
    flexDirection: 'row',
    gap: 10,
  },
  errorButton: {
    minWidth: 96,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111827',
    paddingHorizontal: 14,
  },
  errorButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
});

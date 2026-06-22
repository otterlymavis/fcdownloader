import React, { forwardRef } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import WebView, {
  WebViewMessageEvent,
  WebViewNavigation,
  WebViewProps,
} from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { INJECTED_SCRIPT } from '../constants/injectedScript';
import { translate } from '../constants/translations';
import { CommonLanguageCode } from '../lib/languageProfiles';

// No "wv" tag — Vimeo and other sites block playback when they detect a WebView UA
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

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
  resolvedLanguage?: CommonLanguageCode;
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
    { initialUrl, onMessage, onNavigationChange, onExtractPage, desktopMode = false, resolvedLanguage = 'en', style, ...rest },
    ref
  ) => {
    if (Platform.OS === 'web') {
      return (
        <View style={[styles.webRoot, style]}>
          <Text style={styles.webTitle}>{translate('browserWebTitle', resolvedLanguage)}</Text>
          <Text style={styles.webText} numberOfLines={3}>
            {translate('browserWebText', resolvedLanguage)}
          </Text>
          <Text style={styles.webUrl} numberOfLines={2}>{initialUrl}</Text>
          <View style={styles.errorActions}>
            <Pressable style={styles.errorButton} onPress={() => onExtractPage?.(initialUrl)}>
              <Text style={styles.errorButtonText}>{translate('extractMedia', resolvedLanguage)}</Text>
            </Pressable>
            <Pressable style={styles.webSecondaryButton} onPress={() => Linking.openURL(initialUrl).catch(() => {})}>
              <Text style={styles.webSecondaryButtonText}>{translate('openPage', resolvedLanguage)}</Text>
            </Pressable>
          </View>
        </View>
      );
    }

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
    const ua = isXhsUrl(initialUrl)
      ? XHS_UA
      : desktopMode
      ? DESKTOP_UA
      : Platform.OS === 'ios'
      ? IOS_UA
      : MOBILE_UA;
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
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly={Platform.OS !== 'ios'}
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
            <Text style={styles.errorTitle}>{translate('pageLoadFailed', resolvedLanguage)}</Text>
            <Text style={styles.errorText} numberOfLines={3}>
              {description || translate('webViewError', resolvedLanguage, { code })}
            </Text>
            {isXhsUrl(initialUrl) && (
              <Text style={styles.errorHint}>
                {translate('xhsWebViewHint', resolvedLanguage)}
              </Text>
            )}
            <View style={styles.errorActions}>
              <Pressable style={styles.errorButton} onPress={reload}>
                <Text style={styles.errorButtonText}>{translate('retry', resolvedLanguage)}</Text>
              </Pressable>
              <Pressable style={styles.errorButton} onPress={() => onExtractPage?.(initialUrl)}>
                <Text style={styles.errorButtonText}>{translate('extract', resolvedLanguage)}</Text>
              </Pressable>
              <Pressable style={styles.errorButton} onPress={() => Linking.openURL(initialUrl).catch(() => {})}>
                <Text style={styles.errorButtonText}>{translate('open', resolvedLanguage)}</Text>
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
  webRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    backgroundColor: '#f8fafc',
  },
  webTitle: {
    color: '#111827',
    fontSize: 19,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  webText: {
    color: '#4b5563',
    fontSize: 14,
    lineHeight: 20,
    maxWidth: 520,
    textAlign: 'center',
  },
  webUrl: {
    color: '#6b7280',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 20,
    marginTop: 10,
    maxWidth: 560,
    textAlign: 'center',
  },
  webSecondaryButton: {
    minWidth: 96,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: '#d1d5db',
    borderWidth: 1,
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
  },
  webSecondaryButtonText: {
    color: '#111827',
    fontSize: 13,
    fontWeight: '700',
  },
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

import React, { forwardRef } from 'react';
import { StyleSheet } from 'react-native';
import WebView, {
  WebViewMessageEvent,
  WebViewNavigation,
  WebViewProps,
} from 'react-native-webview';
import { INJECTED_SCRIPT } from '../constants/injectedScript';

// No "wv" tag — Vimeo and other sites block playback when they detect a WebView UA
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

interface Props extends Partial<WebViewProps> {
  initialUrl: string;
  onMessage: (e: WebViewMessageEvent) => void;
  onNavigationChange?: (url: string) => void;
  desktopMode?: boolean;
}

const BrowserView = forwardRef<WebView, Props>(
  (
    { initialUrl, onMessage, onNavigationChange, desktopMode = false, style, ...rest },
    ref
  ) => {
    const handleNavStateChange = (state: WebViewNavigation) => {
      if (onNavigationChange && state.url) onNavigationChange(state.url);
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
        // Cookie sharing — WKHTTPCookieStore ↔ URLSession
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        domStorageEnabled
        // Media
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsFullscreenVideo
        // User-agent
        userAgent={desktopMode ? DESKTOP_UA : MOBILE_UA}
        // Navigation
        onNavigationStateChange={handleNavStateChange}
        onLoadStart={(e) => onNavigationChange?.(e.nativeEvent.url)}
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
});

import { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'FCDownloader',
  slug: 'fcdownloader',
  version: '1.0.0',
  orientation: 'default',
  userInterfaceStyle: 'automatic', // dark mode support
  platforms: ['ios', 'android'],
  scheme: 'fcdownloader',
  icon: './assets/icon.png',
  splash: {
    image: './assets/splash-icon.png',
    resizeMode: 'contain',
    backgroundColor: '#000000',
  },
  android: {
    package: 'com.mabisuuu.fcdownloader',
    adaptiveIcon: {
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      backgroundColor: '#000000',
    },
    permissions: [
      'android.permission.INTERNET',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_IMAGES',
    ],
  },
  ios: {
    bundleIdentifier: 'com.mabisuuu.fcdownloader',
    supportsTablet: true,
    infoPlist: {
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      ITSAppUsesNonExemptEncryption: false,
      // Required for iOS Files app sharing
      UIFileSharingEnabled: true,
      LSSupportsOpeningDocumentsInPlace: true,
      // Background modes: fetch keeps URLSession downloads alive when app is suspended
      UIBackgroundModes: ['fetch', 'processing'],
      // External app hand-off — add schemes for apps you want to support
      LSApplicationQueriesSchemes: ['vlc', 'infuse', 'nplayer'],
    },
    entitlements: {
      'com.apple.developer.networking.wifi-info': true,
      'com.apple.security.application-groups': ['group.com.mabisuuu.fcdownloader'],
    },
  },
  plugins: [
    'expo-sharing',
    'expo-video',
    [
      'expo-media-library',
      {
        photosPermission: 'Allow FCDownloader to save videos to your gallery.',
        savePhotosPermission: 'Allow FCDownloader to save videos to your gallery.',
        isAccessMediaLocationEnabled: true,
      },
    ],
    [
      'expo-build-properties',
      {
        android: {
          newArchEnabled: false,
          minSdkVersion: 24,
          // Allow HTTP (not just HTTPS) so a self-hosted HD extractor on the
          // user's LAN — e.g. http://192.168.1.x:8080 — is reachable. Public
          // deploys use HTTPS so this only affects local-network setups.
          usesCleartextTraffic: true,
        },
      },
    ],
    // iOS native MediaMuxer (AVAssetExportSession) — used for HD YouTube mux on iOS
    './plugins/withMediaMuxer',
    // iOS Share Extension — appears in Safari's share sheet
    './plugins/withShareExtension',
    // Uncomment after running `npx expo prebuild` and adding the Swift module:
    // './plugins/withBackgroundAssetDownload',
  ],
  extra: {
    eas: {
      projectId: '47226a0f-42c7-47ba-8e7e-c52d907118fe',
    },
    // Built-in HD extractor backend. Set in .env.local:
    //   EXPO_PUBLIC_EXTRACTOR_URL=https://your-app.fly.dev
    //   EXPO_PUBLIC_EXTRACTOR_TOKEN=...
    // These are inlined at build time. Leave unset to fall back to on-device 360p.
    bundledExtractorUrl:   process.env.EXPO_PUBLIC_EXTRACTOR_URL   ?? '',
    bundledExtractorToken: process.env.EXPO_PUBLIC_EXTRACTOR_TOKEN ?? '',
  },
});

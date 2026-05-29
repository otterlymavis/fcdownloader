import { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const allowInsecureHttp = process.env.FCDL_ALLOW_INSECURE_HTTP === '1';

  return {
    ...config,
    name: 'FCDownloader',
  slug: 'fcdownloader',
  owner: 'mabisuuu',
  version: '1.5.6',
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
    versionCode: 17,
    allowBackup: false,
    adaptiveIcon: {
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      backgroundColor: '#000000',
    },
    permissions: [
      'android.permission.INTERNET',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_IMAGES',
    ],
    blockedPermissions: [
      'android.permission.ACCESS_MEDIA_LOCATION',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_AUDIO',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.VIBRATE',
    ],
  },
  ios: {
    bundleIdentifier: 'com.mabisuuu.fcdownloader',
    supportsTablet: true,
    infoPlist: {
      ...(allowInsecureHttp ? { NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } } : {}),
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
      'com.apple.security.application-groups': ['group.com.mabisuuu.fcdownloader'],
    },
  },
  plugins: [
    'expo-sharing',
    'expo-video',
    [
      'expo-media-library',
      {
        photosPermission: 'Allow FCDownloader to save photos and videos to your gallery.',
        savePhotosPermission: 'Allow FCDownloader to save photos and videos to your gallery.',
        granularPermissions: ['photo', 'video'],
        isAccessMediaLocationEnabled: false,
      },
    ],
    [
      'expo-build-properties',
      {
        android: {
          minSdkVersion: 24,
          // Public releases should use HTTPS. Local/self-hosted LAN builds can
          // opt into HTTP with FCDL_ALLOW_INSECURE_HTTP=1.
          usesCleartextTraffic: allowInsecureHttp,
        },
      },
    ],
    // iOS native MediaMuxer (AVAssetExportSession) — used for HD YouTube mux on iOS
    './plugins/withMediaMuxer',
    // iOS Share Extension — appears in Safari's share sheet
    './plugins/withShareExtension',
  ],
  extra: {
    eas: {
      // Personal EAS project ID — supply via env at build time. EAS CLI sets
      // EXPO_PUBLIC_EAS_PROJECT_ID automatically when you run `eas init`, but
      // it can also be exported manually (`export EAS_PROJECT_ID=...`). Forks
      // of the project should run `eas init` to get their own.
      projectId: process.env.EAS_PROJECT_ID
                 ?? process.env.EXPO_PUBLIC_EAS_PROJECT_ID
                 ?? '',
    },
    // Built-in HD extractor backend. Set in .env.local:
    //   EXPO_PUBLIC_EXTRACTOR_URL=https://your-app.fly.dev
    //   EXPO_PUBLIC_EXTRACTOR_TOKEN=...
    // These are inlined at build time. Leave unset to fall back to on-device 360p.
    bundledExtractorUrl:   process.env.EXPO_PUBLIC_EXTRACTOR_URL   ?? '',
    bundledExtractorToken: process.env.EXPO_PUBLIC_EXTRACTOR_TOKEN ?? '',
  },
  };
};

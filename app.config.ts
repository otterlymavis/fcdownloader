import { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const allowInsecureHttp = process.env.FCDL_ALLOW_INSECURE_HTTP === '1';

  return {
    ...config,
    name: 'FCDownloader',
    slug: 'fcdownloader',
    owner: 'mabisuuu',
    version: '1.5.22',
    orientation: 'default',
    userInterfaceStyle: 'automatic', // dark mode support
    platforms: ['ios', 'android', 'web'],
    scheme: 'fcdownloader',
    icon: './assets/icon.png',
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#000000',
    },
    android: {
      package: 'com.otterpia.fcdownloader',
      versionCode: 26,
      allowBackup: false,
      icon: './web/icon-512.png',
      adaptiveIcon: {
        foregroundImage: './web/icon-512.png',
        backgroundColor: '#ffffff',
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
      intentFilters: [
        {
          action: 'SEND',
          category: ['DEFAULT'],
          data: [{ mimeType: 'text/*' }],
        },
      ],
    },
    ios: {
      bundleIdentifier: 'com.otterpia.fcdownloader',
      buildNumber: '29',
      supportsTablet: true,
      infoPlist: {
        ...(allowInsecureHttp ? { NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } } : {}),
        ITSAppUsesNonExemptEncryption: false,
        // Required for iOS Files app sharing
        UIFileSharingEnabled: true,
        LSSupportsOpeningDocumentsInPlace: true,
        // Background fetch support. BGProcessingTask is not used, so do not
        // declare the "processing" mode that requires BGTask identifiers.
        UIBackgroundModes: ['fetch'],
        // External app hand-off — add schemes for apps you want to support
        LSApplicationQueriesSchemes: ['vlc', 'infuse', 'nplayer'],
      },
      entitlements: {
        'com.apple.security.application-groups': ['group.com.otterpia.fcdownloader'],
      },
    },
    plugins: [
      'expo-sharing',
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
          ios: {
            deploymentTarget: '15.1',
          },
        },
      ],
      // Keep Debug iPhone builds usable when Metro is unavailable by embedding
      // a JS bundle; simulator Debug builds still load from Metro.
      './plugins/withIosDeviceDebugBundle',
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
        build: {
          experimental: {
            ios: {
              appExtensions: [
                {
                  targetName: 'ShareExtension',
                  bundleIdentifier: 'com.otterpia.fcdownloader.ShareExtension',
                  entitlements: {
                    'com.apple.security.application-groups': ['group.com.otterpia.fcdownloader'],
                  },
                },
              ],
            },
          },
        },
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

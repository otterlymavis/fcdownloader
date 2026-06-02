/**
 * Bridge to the Android download keep-alive foreground service
 * (DownloadServiceModule.kt). While downloads are active it holds the process
 * + a partial wake lock so backgrounding the app or turning off the screen
 * doesn't stall the JS streaming download loops.
 *
 * Every call is guarded: on iOS, or on an Android build that doesn't ship the
 * native module, these are no-ops — callers never need to branch.
 */
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

interface DownloadServiceNative {
  start: (count: number) => Promise<boolean>;
  stop: () => Promise<boolean>;
}

const native = (NativeModules as Record<string, unknown>)?.DownloadService as
  | DownloadServiceNative
  | undefined;

let notifPermissionAsked = false;

async function ensureNotificationPermission(): Promise<void> {
  if (Platform.OS !== 'android' || notifPermissionAsked) return;
  notifPermissionAsked = true;
  // POST_NOTIFICATIONS only exists on Android 13+ (API 33). On older versions
  // the constant is undefined and the foreground notification shows anyway.
  const perm = (PermissionsAndroid.PERMISSIONS as Record<string, string>).POST_NOTIFICATIONS;
  if (!perm) return;
  try {
    await PermissionsAndroid.request(perm as Parameters<typeof PermissionsAndroid.request>[0]);
  } catch {
    /* denial is non-fatal — the service still runs, just without a visible notification */
  }
}

export async function startDownloadKeepAlive(count: number): Promise<void> {
  if (Platform.OS !== 'android' || !native) return;
  await ensureNotificationPermission();
  try {
    await native.start(count);
  } catch {
    /* best-effort */
  }
}

export async function stopDownloadKeepAlive(): Promise<void> {
  if (Platform.OS !== 'android' || !native) return;
  try {
    await native.stop();
  } catch {
    /* best-effort */
  }
}

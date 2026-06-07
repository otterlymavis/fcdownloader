package com.mabisuuu.fcdownloader

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    rewriteSendIntent(intent)
    super.onCreate(null)
  }

  override fun onNewIntent(intent: Intent) {
    rewriteSendIntent(intent)
    super.onNewIntent(intent)
  }

  /**
   * When the app is opened from the system share sheet (ACTION_SEND, text/plain),
   * Android delivers the shared text in EXTRA_TEXT — which React Native's Linking
   * does NOT surface. Rewrite the intent into the fcdownloader://share?url=... deep
   * link the JS already handles, so sharing a link from any app drops it straight
   * into the paste box. Shared text like "caption https://..." is reduced to the URL.
   */
  private fun rewriteSendIntent(intent: Intent?) {
    if (intent?.action != Intent.ACTION_SEND) return
    val shared = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim() ?: return
    if (shared.isEmpty()) return
    val url = Regex("https?://\\S+").find(shared)?.value ?: shared
    intent.action = Intent.ACTION_VIEW
    intent.data = Uri.parse("fcdownloader://share?url=" + Uri.encode(url))
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}

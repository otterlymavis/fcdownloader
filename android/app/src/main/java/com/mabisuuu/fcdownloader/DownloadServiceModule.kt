package com.mabisuuu.fcdownloader

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS bridge to the download keep-alive foreground service.
 *  - start(count): begin/refresh the foreground service with the active count.
 *  - stop(): tear it down when no downloads remain.
 */
class DownloadServiceModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "DownloadService"

    @ReactMethod
    fun start(count: Int, promise: Promise) {
        try {
            val intent = Intent(reactContext, DownloadKeepAliveService::class.java)
                .putExtra(DownloadKeepAliveService.EXTRA_COUNT, count)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactContext.startForegroundService(intent)
            } else {
                reactContext.startService(intent)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("start_failed", e)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        try {
            reactContext.stopService(Intent(reactContext, DownloadKeepAliveService::class.java))
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("stop_failed", e)
        }
    }
}

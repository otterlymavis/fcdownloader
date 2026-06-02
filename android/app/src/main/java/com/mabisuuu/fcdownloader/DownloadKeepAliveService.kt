package com.mabisuuu.fcdownloader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the app process — and the JS download loops
 * running inside it — alive while transfers are in progress. Without it, Android
 * suspends the process shortly after the app is backgrounded (or the screen is
 * turned off), which stalls the streaming `reader.read()` download loops in
 * serverDownloader/hls/dash and surfaces as a failed download.
 *
 * Lifecycle is driven from JS (DownloadServiceModule): start(count) when the
 * active-download count goes above zero, stop() when it returns to zero.
 */
class DownloadKeepAliveService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val count = intent?.getIntExtra(EXTRA_COUNT, 0) ?: 0
        startInForeground(count)
        acquireWakeLock()
        // START_STICKY so the OS keeps the service if it has to reclaim memory.
        return START_STICKY
    }

    private fun startInForeground(count: Int) {
        createChannel()
        val text = if (count > 1) "Downloading $count items…" else "Downloading…"
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("FCDownloader")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fcdownloader:downloads").apply {
            setReferenceCounted(false)
            // Safety cap; the service is normally stopped well before this.
            acquire(60 * 60 * 1000L)
        }
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {
        }
        wakeLock = null
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val ch = NotificationChannel(
                    CHANNEL_ID,
                    "Downloads",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply { description = "Keeps downloads running while the app is in the background" }
                nm.createNotificationChannel(ch)
            }
        }
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    companion object {
        const val CHANNEL_ID = "fcdl_downloads"
        const val NOTIF_ID = 4711
        const val EXTRA_COUNT = "count"
    }
}

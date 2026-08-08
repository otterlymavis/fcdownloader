package com.mabisuuu.fcdownloader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
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
    private val renewHandler = Handler(Looper.getMainLooper())
    private val renewWakeLock = object : Runnable {
        override fun run() {
            refreshWakeLock()
            renewHandler.postDelayed(this, WAKE_LOCK_RENEW_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // A null intent means the system restarted us on its own. Our lifecycle is
        // entirely JS-driven, so there is no download in flight and nothing that
        // will ever call stop() — coming back would mean a wake lock and a false
        // "Downloading…" notification held indefinitely. Refuse and stand down.
        if (intent == null) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        val count = intent.getIntExtra(EXTRA_COUNT, 0)
        startInForeground(count)
        refreshWakeLock()
        scheduleWakeLockRenewal()
        return START_NOT_STICKY
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

    /**
     * (Re)takes the wake lock with a fresh timeout. The timeout is a safety cap
     * against a leaked service, but a single large download can outlive it, and
     * onStartCommand only fires when the active-download count *changes* — so
     * nothing would re-arm it and the screen-off stall this service exists to
     * prevent would silently come back. scheduleWakeLockRenewal keeps it fresh.
     */
    private fun refreshWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        val lock = wakeLock ?: pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fcdownloader:downloads").also {
            it.setReferenceCounted(false)
            wakeLock = it
        }
        lock.acquire(WAKE_LOCK_TIMEOUT_MS)
    }

    private fun scheduleWakeLockRenewal() {
        renewHandler.removeCallbacks(renewWakeLock)
        renewHandler.postDelayed(renewWakeLock, WAKE_LOCK_RENEW_MS)
    }

    private fun releaseWakeLock() {
        renewHandler.removeCallbacks(renewWakeLock)
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {
        }
        wakeLock = null
    }

    /**
     * API 35+ caps cumulative dataSync foreground-service runtime (~6h/24h). When
     * the budget runs out the platform calls this, and an app that does not stop
     * itself is killed with ForegroundServiceDidNotStopInTimeException.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        releaseWakeLock()
        stopSelf(startId)
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
        private const val WAKE_LOCK_TIMEOUT_MS = 60 * 60 * 1000L
        private const val WAKE_LOCK_RENEW_MS = 45 * 60 * 1000L
    }
}

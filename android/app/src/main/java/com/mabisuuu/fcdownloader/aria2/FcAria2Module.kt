package com.mabisuuu.fcdownloader.aria2

import android.content.Context
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import okhttp3.OkHttpClient
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger

/**
 * FcAria2Module — React Native bridge to the bundled aria2c binary.
 *
 * This module provides aria2c RPC access to the JavaScript layer so that
 * aria2Transport.ts can manage large resumable downloads on Android.
 *
 * aria2c is an OPTIONAL transport layer. It only handles direct single-file
 * downloads. HLS/DASH downloads use their own assemblers (hlsDownloader.ts,
 * dashDownloader.ts) and are NOT routed through this module.
 *
 * Exposed methods (callable from JS via NativeModules.FcAria2):
 *   startRpc()                      → starts aria2c --enable-rpc
 *   addUri(options)                 → addUri RPC call, returns GID
 *   getStatus(gid)                  → tellStatus RPC call
 *   removeDownload(gid)             → remove + removeDownloadResult
 *   stopRpc()                       → terminates the aria2c process
 *
 * The binary is loaded from the app's native library directory:
 *   context.applicationInfo.nativeLibraryDir + "/libaria2c.so"
 * If the binary is absent, all methods reject gracefully — the JS layer
 * falls back to expo-file-system.
 */
@ReactModule(name = FcAria2Module.NAME)
class FcAria2Module(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "FcAria2"
        private const val TAG = "FcAria2"
        private const val RPC_PORT = 6800
        private const val RPC_URL = "http://127.0.0.1:$RPC_PORT/jsonrpc"
        private val rpcIdCounter = AtomicInteger(1)
    }

    private var aria2Process: Process? = null
    private val httpClient = OkHttpClient()

    override fun getName(): String = NAME

    // ── startRpc ─────────────────────────────────────────────────────────────

    @ReactMethod
    fun startRpc(promise: Promise) {
        try {
            // If already running, reuse
            if (aria2Process?.isAlive == true) {
                promise.resolve(true)
                return
            }

            val binaryPath = getBinaryPath() ?: run {
                promise.reject("ARIA2_UNAVAILABLE", "aria2c binary not found in nativeLibraryDir")
                return
            }

            // Make executable (required after extraction from APK)
            File(binaryPath).setExecutable(true, false)

            val process = ProcessBuilder(
                binaryPath,
                "--enable-rpc",
                "--rpc-listen-port=$RPC_PORT",
                "--rpc-listen-all=false",
                "--rpc-allow-origin-all=true",
                "--log-level=warn",
                "--max-concurrent-downloads=5",
                "--split=4",
                "--max-connection-per-server=4",
                "--min-split-size=5M",
                "--continue=true",
            )
                .redirectErrorStream(true)
                .start()

            aria2Process = process

            // Give aria2c 500ms to start up
            Thread.sleep(500)

            if (!process.isAlive) {
                val output = process.inputStream.bufferedReader().readText()
                promise.reject("ARIA2_START_FAILED", "aria2c exited early: $output")
                return
            }

            Log.i(TAG, "aria2c RPC started on port $RPC_PORT")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "startRpc failed: ${e.message}")
            promise.reject("ARIA2_ERROR", e.message ?: "startRpc failed", e)
        }
    }

    // ── addUri ────────────────────────────────────────────────────────────────

    @ReactMethod
    fun addUri(options: ReadableMap, promise: Promise) {
        try {
            val uri = options.getString("uri")
                ?: return promise.reject("ARIA2_ERROR", "uri is required")
            val dir = options.getString("dir") ?: reactApplicationContext.cacheDir.absolutePath
            val out = options.getString("out") ?: "aria2_download"
            val connections = if (options.hasKey("connections")) options.getInt("connections") else 4
            val splits = if (options.hasKey("splits")) options.getInt("splits") else connections

            val headerArray = JSONArray()
            if (options.hasKey("headers")) {
                val headersList = options.getArray("headers")
                if (headersList != null) {
                    for (i in 0 until headersList.size()) {
                        headerArray.put(headersList.getString(i))
                    }
                }
            }

            val params = JSONArray().apply {
                put(JSONArray().apply { put(uri) })   // uris array
                put(JSONObject().apply {              // options
                    put("dir", dir)
                    put("out", out)
                    put("max-connection-per-server", connections)
                    put("split", splits)
                    if (headerArray.length() > 0) put("header", headerArray)
                    put("continue", "true")
                })
            }

            val response = rpcCall("aria2.addUri", params)
            val gid = response.getString("result")
            Log.i(TAG, "addUri GID=$gid uri=${uri.take(80)}")
            promise.resolve(gid)
        } catch (e: Exception) {
            Log.e(TAG, "addUri failed: ${e.message}")
            promise.reject("ARIA2_ERROR", e.message ?: "addUri failed", e)
        }
    }

    // ── getStatus ─────────────────────────────────────────────────────────────

    @ReactMethod
    fun getStatus(gid: String, promise: Promise) {
        try {
            val params = JSONArray().apply { put(gid) }
            val response = rpcCall("aria2.tellStatus", params)
            val result = response.getJSONObject("result")

            val map = WritableNativeMap()
            map.putString("status", result.optString("status", "unknown"))
            map.putString("completedLength", result.optString("completedLength", "0"))
            map.putString("totalLength", result.optString("totalLength", "0"))
            map.putString("downloadSpeed", result.optString("downloadSpeed", "0"))
            map.putString("errorMessage", result.optString("errorMessage", ""))
            promise.resolve(map)
        } catch (e: Exception) {
            Log.e(TAG, "getStatus failed: ${e.message}")
            promise.reject("ARIA2_ERROR", e.message ?: "getStatus failed", e)
        }
    }

    // ── removeDownload ────────────────────────────────────────────────────────

    @ReactMethod
    fun removeDownload(gid: String, promise: Promise) {
        try {
            val params = JSONArray().apply { put(gid) }
            try { rpcCall("aria2.remove", params) } catch (_: Exception) {}
            try { rpcCall("aria2.removeDownloadResult", params) } catch (_: Exception) {}
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ARIA2_ERROR", e.message ?: "removeDownload failed", e)
        }
    }

    // ── stopRpc ───────────────────────────────────────────────────────────────

    @ReactMethod
    fun stopRpc(promise: Promise) {
        try {
            aria2Process?.destroy()
            aria2Process = null
            Log.i(TAG, "aria2c RPC stopped")
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ARIA2_ERROR", e.message ?: "stopRpc failed", e)
        }
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    private fun getBinaryPath(): String? {
        val nativeLibDir = reactApplicationContext.applicationInfo.nativeLibraryDir
        val binary = File(nativeLibDir, "libaria2c.so")
        return if (binary.exists()) binary.absolutePath else null
    }

    private fun rpcCall(method: String, params: JSONArray): JSONObject {
        val id = rpcIdCounter.getAndIncrement()
        val body = JSONObject().apply {
            put("jsonrpc", "2.0")
            put("id", id)
            put("method", method)
            put("params", params)
        }

        val request = Request.Builder()
            .url(RPC_URL)
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        val response = httpClient.newCall(request).execute()
        val responseBody = response.body?.string() ?: throw IOException("empty response")
        val json = JSONObject(responseBody)

        if (json.has("error")) {
            val err = json.getJSONObject("error")
            throw IOException("aria2c RPC error: ${err.optString("message", "unknown")} (code=${err.optInt("code")})")
        }

        return json
    }

    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        try { aria2Process?.destroy() } catch (_: Exception) {}
        aria2Process = null
    }
}

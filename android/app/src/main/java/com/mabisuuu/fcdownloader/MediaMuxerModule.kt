package com.mabisuuu.fcdownloader

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.Executors

/**
 * Lossless `-c copy` style mux of an MP4 (H.264) video track + M4A (AAC) audio
 * track into a single MP4. Uses Android's stdlib MediaExtractor + MediaMuxer —
 * no external native libs.
 *
 * Caller is responsible for passing files in a compatible container (mp4/m4a).
 * The video and audio tracks are copied bit-for-bit; sample timestamps are
 * preserved so A/V sync is identical to the source streams.
 */
class MediaMuxerModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "MediaMuxerModule"
        private const val BUFFER_SIZE = 1 * 1024 * 1024  // 1 MiB
    }

    private val executor = Executors.newCachedThreadPool()

    override fun getName() = "MediaMuxerModule"

    private fun stripScheme(path: String): String =
        if (path.startsWith("file://")) path.removePrefix("file://") else path

    @ReactMethod
    fun mux(videoPath: String, audioPath: String, outputPath: String, promise: Promise) {
        executor.execute {
            val v = stripScheme(videoPath)
            val a = stripScheme(audioPath)
            val o = stripScheme(outputPath)

            var videoExt: MediaExtractor? = null
            var audioExt: MediaExtractor? = null
            var muxer:    MediaMuxer?     = null

            try {
                File(o).delete()  // MediaMuxer fails if the output file exists

                videoExt = MediaExtractor().also { it.setDataSource(v) }
                audioExt = MediaExtractor().also { it.setDataSource(a) }

                // Find the first video track in `videoExt`
                var videoSrcIdx = -1
                var videoFormat: MediaFormat? = null
                for (i in 0 until videoExt.trackCount) {
                    val fmt = videoExt.getTrackFormat(i)
                    if (fmt.getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true) {
                        videoSrcIdx = i; videoFormat = fmt; break
                    }
                }
                if (videoSrcIdx < 0 || videoFormat == null) {
                    promise.reject("MUX_NO_VIDEO", "No video track in $v")
                    return@execute
                }
                videoExt.selectTrack(videoSrcIdx)

                // Find the first audio track in `audioExt`
                var audioSrcIdx = -1
                var audioFormat: MediaFormat? = null
                for (i in 0 until audioExt.trackCount) {
                    val fmt = audioExt.getTrackFormat(i)
                    if (fmt.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) {
                        audioSrcIdx = i; audioFormat = fmt; break
                    }
                }
                if (audioSrcIdx < 0 || audioFormat == null) {
                    promise.reject("MUX_NO_AUDIO", "No audio track in $a")
                    return@execute
                }
                audioExt.selectTrack(audioSrcIdx)

                muxer = MediaMuxer(o, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                val videoDstIdx = muxer.addTrack(videoFormat)
                val audioDstIdx = muxer.addTrack(audioFormat)
                muxer.start()

                val buffer = ByteBuffer.allocate(BUFFER_SIZE)
                val info = MediaCodec.BufferInfo()

                // Copy video samples
                while (true) {
                    info.offset = 0
                    val sz = videoExt.readSampleData(buffer, 0)
                    if (sz < 0) break
                    info.size = sz
                    info.presentationTimeUs = videoExt.sampleTime
                    val flags = videoExt.sampleFlags
                    info.flags = if (flags and MediaExtractor.SAMPLE_FLAG_SYNC != 0)
                        MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
                    muxer.writeSampleData(videoDstIdx, buffer, info)
                    videoExt.advance()
                }

                // Copy audio samples
                while (true) {
                    info.offset = 0
                    val sz = audioExt.readSampleData(buffer, 0)
                    if (sz < 0) break
                    info.size = sz
                    info.presentationTimeUs = audioExt.sampleTime
                    info.flags = 0
                    muxer.writeSampleData(audioDstIdx, buffer, info)
                    audioExt.advance()
                }

                muxer.stop()
                Log.i(TAG, "Muxed → $o")
                promise.resolve(o)
            } catch (e: Exception) {
                Log.e(TAG, "Mux failed", e)
                try { File(o).delete() } catch (_: Exception) {}
                promise.reject("MUX_ERROR", e.message ?: "unknown error")
            } finally {
                try { muxer?.release()    } catch (_: Exception) {}
                try { videoExt?.release() } catch (_: Exception) {}
                try { audioExt?.release() } catch (_: Exception) {}
            }
        }
    }
}

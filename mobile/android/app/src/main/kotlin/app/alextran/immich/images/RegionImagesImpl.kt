package app.alextran.immich.images

import android.content.ContentUris
import android.content.Context
import android.os.CancellationSignal
import android.os.OperationCanceledException
import android.os.ParcelFileDescriptor
import android.provider.MediaStore.Images
import app.alextran.immich.core.HttpClientManager
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/** The app's own decoders of parts of very large images (native/region, through region_jni.c). */
object RegionDecoder {
  init {
    System.loadLibrary("immich_region")
  }

  /** Opens an image file; writes its upright {width, height} into [size]. Throws IOException if it cannot. */
  @JvmStatic
  external fun open(path: String, size: IntArray): Long

  /**
   * Decodes a part, [sample] times smaller, into a malloc'd RGBA buffer; writes {width, height, rowBytes} into [info].
   * Not thread safe for one image.
   */
  @JvmStatic
  external fun decode(handle: Long, x: Int, y: Int, width: Int, height: Int, sample: Int, info: IntArray): Long

  @JvmStatic
  external fun close(handle: Long)
}

// Downloaded remote images, kept for the next time they are shown, the least recently used removed past this size
private const val DOWNLOADS_MAX_BYTES = 512L * 1024 * 1024

private class RegionImage(val handle: Long, val descriptor: ParcelFileDescriptor?, val file: File?) {
  var closed = false
}

private class RegionRequest(val signal: CancellationSignal)

class RegionImagesImpl(context: Context) : RegionImageApi {
  private val ctx = context.applicationContext
  private val images = ConcurrentHashMap<Long, RegionImage>()
  private val requests = ConcurrentHashMap<Long, RegionRequest>()

  companion object {
    val CANCELLED = Result.success<Map<String, Long>?>(null)

    // Process-lifetime pools, as RemoteImagesImpl's: opening downloads and indexes (PNG), decoding is short. The
    // decodes of one image run one at a time (it is not thread safe), those of two images side by side.
    private val openExecutor = Executors.newFixedThreadPool(2)
    private val decodeExecutor = Executors.newFixedThreadPool(2)
    private val nextId = AtomicLong(1)

    // the downloads open now, which eviction leaves alone (the decoders open the file again for each part)
    private val openFiles = ConcurrentHashMap<File, Int>()
  }

  private val downloads = File(ctx.cacheDir, "region").apply { mkdirs() }

  override fun open(localAssetId: String?, url: String?, requestId: Long, callback: (Result<Map<String, Long>?>) -> Unit) {
    val signal = CancellationSignal()
    requests[requestId] = RegionRequest(signal)
    openExecutor.execute {
      var descriptor: ParcelFileDescriptor? = null
      var file: File? = null
      try {
        signal.throwIfCanceled()
        val path = if (localAssetId != null) {
          val uri = ContentUris.withAppendedId(Images.Media.EXTERNAL_CONTENT_URI, localAssetId.toLong())
          descriptor = ctx.contentResolver.openFileDescriptor(uri, "r", signal)
            ?: throw IOException("Could not open $localAssetId")
          // the file of the descriptor, which the decoders open (again for each part, as the descriptor's position
          // is shared): the descriptor stays open as long as the image
          "/proc/self/fd/${descriptor.fd}"
        } else {
          file = download(url ?: throw IllegalArgumentException("No asset or URL"), signal)
          openFiles.merge(file, 1, Int::plus)
          file.path
        }
        signal.throwIfCanceled()
        val size = IntArray(2)
        val handle = RegionDecoder.open(path, size)
        val id = nextId.getAndIncrement()
        images[id] = RegionImage(handle, descriptor, file)
        requests.remove(requestId)
        callback(Result.success(mapOf("id" to id, "width" to size[0].toLong(), "height" to size[1].toLong())))
      } catch (e: Exception) {
        descriptor?.close()
        file?.let(::release)
        requests.remove(requestId)
        callback(if (e is OperationCanceledException || signal.isCanceled) CANCELLED else Result.failure(e))
      }
    }
  }

  override fun decode(
    imageId: Long,
    requestId: Long,
    x: Long,
    y: Long,
    width: Long,
    height: Long,
    sample: Long,
    callback: (Result<Map<String, Long>?>) -> Unit
  ) {
    val signal = CancellationSignal()
    requests[requestId] = RegionRequest(signal)
    decodeExecutor.execute {
      try {
        val image = images[imageId]
        val result = if (image == null || signal.isCanceled) null else synchronized(image) {
          if (image.closed || signal.isCanceled) {
            null
          } else {
            val info = IntArray(3)
            val pointer =
              RegionDecoder.decode(image.handle, x.toInt(), y.toInt(), width.toInt(), height.toInt(), sample.toInt(), info)
            mapOf(
              "pointer" to pointer,
              "width" to info[0].toLong(),
              "height" to info[1].toLong(),
              "rowBytes" to info[2].toLong()
            )
          }
        }
        requests.remove(requestId)
        // Delivered even if cancelled meanwhile: Dart frees the buffer itself when it sees the cancel.
        callback(if (result == null) CANCELLED else Result.success(result))
      } catch (e: Exception) {
        requests.remove(requestId)
        callback(if (signal.isCanceled) CANCELLED else Result.failure(e))
      }
    }
  }

  override fun cancel(requestId: Long) {
    requests.remove(requestId)?.signal?.cancel()
  }

  override fun close(imageId: Long) {
    val image = images.remove(imageId) ?: return
    decodeExecutor.execute {
      synchronized(image) {
        image.closed = true
        RegionDecoder.close(image.handle)
      }
      image.descriptor?.close()
      image.file?.let(::release)
    }
  }

  private fun release(file: File) {
    openFiles.computeIfPresent(file) { _, count -> if (count > 1) count - 1 else null }
  }

  // Downloads a remote image into the cache (once: it is kept, by its URL, for the next time), through the app's
  // HTTP client, to a file rather than into memory, as originals can be large
  private fun download(url: String, signal: CancellationSignal): File {
    val name = MessageDigest.getInstance("SHA-256").digest(url.toByteArray()).joinToString("") { "%02x".format(it) }
    val file = File(downloads, name)
    synchronized(name.intern()) {
      if (file.exists()) {
        file.setLastModified(System.currentTimeMillis())
        return file
      }
      val client = HttpClientManager.getClient().newBuilder().cache(null).build()
      val call = client.newCall(Request.Builder().url(url).build())
      signal.setOnCancelListener(call::cancel)
      val part = File(downloads, "$name.part")
      try {
        call.execute().use { response ->
          if (!response.isSuccessful) {
            throw IOException("HTTP ${response.code}: ${response.message}")
          }
          val body = response.body ?: throw IOException("Empty response body")
          part.outputStream().use { output -> body.byteStream().copyTo(output) }
        }
        signal.throwIfCanceled()
        if (!part.renameTo(file)) {
          throw IOException("Could not save the download")
        }
      } catch (e: Exception) {
        part.delete()
        throw if (signal.isCanceled) OperationCanceledException() else e
      } finally {
        signal.setOnCancelListener(null)
      }
    }
    evict(file)
    return file
  }

  private fun evict(keep: File) {
    val files = downloads.listFiles { file -> !file.name.endsWith(".part") }?.sortedByDescending { it.lastModified() }
      ?: return
    var total = 0L
    for (file in files) {
      total += file.length()
      if (total > DOWNLOADS_MAX_BYTES && file != keep && !openFiles.containsKey(file)) {
        file.delete()
      }
    }
  }
}

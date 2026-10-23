package app.alextran.immich.background

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import app.alextran.immich.R

private const val TAG = "UserUploadJob"

/**
 * Keeps a backup the app runs while it is open going when the user leaves the app (Android 14+): a user-initiated
 * data transfer job, which the system lets run for as long as the transfer goes on, with a notification. The upload
 * itself goes on in the app's engine; the job only keeps the app running, and ends when the backup does.
 */
class UserUploadJobService : JobService() {
  companion object {
    /// its own namespace: WorkManager hands out job ids of the app's default namespace
    private const val NAMESPACE = "immich.user_upload"
    private const val JOB_ID = 1
    private const val NOTIFICATION_ID = 101

    @Volatile
    private var running: Pair<UserUploadJobService, JobParameters>? = null

    /** Whether the job keeps the app running now */
    val isRunning: Boolean
      get() = running != null

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun scheduler(ctx: Context): JobScheduler =
      ctx.getSystemService(JobScheduler::class.java).forNamespace(NAMESPACE)

    /**
     * Starts the job, while the app is in front: the system only accepts a user-initiated job then. Returns whether
     * the job is scheduled or runs
     */
    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    fun start(ctx: Context): Boolean {
      val scheduler = scheduler(ctx)
      if (scheduler.getPendingJob(JOB_ID) != null) {
        return true
      }
      val job = JobInfo.Builder(JOB_ID, ComponentName(ctx, UserUploadJobService::class.java))
        .setUserInitiated(true)
        // a user-initiated job must name a network; which networks a backup uses is decided by the app
        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
        .build()
      return try {
        scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS
      } catch (error: RuntimeException) {
        Log.w(TAG, "Could not schedule the upload job", error)
        false
      }
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    fun finish(ctx: Context) {
      val job = running
      running = null
      if (job != null) {
        job.first.jobFinished(job.second, false)
      } else {
        scheduler(ctx).cancel(JOB_ID)
      }
    }
  }

  override fun onStartJob(params: JobParameters): Boolean {
    // only scheduled on Android 14 and later
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      return false
    }
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(
        BackgroundWorker.NOTIFICATION_CHANNEL_ID,
        getString(R.string.background_worker_notification_channel_name),
        NotificationManager.IMPORTANCE_LOW
      )
    )
    val (title, body) = BackgroundWorkerPreferences(this).getNotificationConfig()
    val notification = NotificationCompat.Builder(this, BackgroundWorker.NOTIFICATION_CHANNEL_ID)
      .setSmallIcon(R.drawable.notification_icon)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
      .setContentTitle(title)
      .setContentText(body)
      .build()
    // required of a user-initiated job shortly after it starts
    setNotification(params, NOTIFICATION_ID, notification, JOB_END_NOTIFICATION_POLICY_REMOVE)
    running = Pair(this, params)
    Log.i(TAG, "Keeping the backup going in the background")
    return true
  }

  override fun onStopJob(params: JobParameters): Boolean {
    // stopped by the system (no network, or the user stopped it in the task manager): the backup is resumed when the
    // app is opened again
    Log.i(TAG, "The system stopped the upload job")
    running = null
    return false
  }
}

class UserUploadApiImpl(context: Context) : UserUploadApi {
  private val ctx: Context = context.applicationContext

  // the notification of the job says what it does (BackgroundWorkerPreferences)
  override fun start(title: String, subtitle: String): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && UserUploadJobService.start(ctx)

  // the notification of the job does not show progress
  override fun progress(completed: Long, total: Long) {}

  override fun finish() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      UserUploadJobService.finish(ctx)
    }
  }
}

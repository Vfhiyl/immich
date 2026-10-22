package app.alextran.immich.background

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager

/** Why a backup in the background waits: it only runs while the screen is off and the phone is plugged in */
enum class BackgroundPause { SCREEN_ON, NOT_CHARGING, POWER_SAVE, HOT }

data class DeviceState(
  val isInteractive: Boolean,
  val isPluggedIn: Boolean,
  val isPowerSaveMode: Boolean,
  /** a `PowerManager.THERMAL_STATUS_*`; `THERMAL_STATUS_NONE` before Android 10 */
  val thermalStatus: Int,
)

object BackgroundConditions {
  fun pauseReason(state: DeviceState): BackgroundPause? = when {
    state.isInteractive -> BackgroundPause.SCREEN_ON
    !state.isPluggedIn -> BackgroundPause.NOT_CHARGING
    state.isPowerSaveMode -> BackgroundPause.POWER_SAVE
    // "severe throttling": the system itself is slowing the phone down to cool it
    state.thermalStatus >= PowerManager.THERMAL_STATUS_SEVERE -> BackgroundPause.HOT
    else -> null
  }

  fun read(ctx: Context): DeviceState {
    val power = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
    // the sticky battery broadcast, as WorkManager reads it for its charging constraint
    val battery = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    return DeviceState(
      isInteractive = power.isInteractive,
      isPluggedIn = (battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0,
      isPowerSaveMode = power.isPowerSaveMode,
      thermalStatus = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) power.currentThermalStatus else PowerManager.THERMAL_STATUS_NONE,
    )
  }

  fun pauseReason(ctx: Context): BackgroundPause? = pauseReason(read(ctx))
}

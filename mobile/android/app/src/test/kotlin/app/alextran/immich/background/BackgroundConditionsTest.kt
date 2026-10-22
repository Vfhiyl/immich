package app.alextran.immich.background

import android.os.PowerManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BackgroundConditionsTest {
  private val idle = DeviceState(
    isInteractive = false,
    isPluggedIn = true,
    isPowerSaveMode = false,
    thermalStatus = PowerManager.THERMAL_STATUS_NONE,
  )

  @Test
  fun `backs up while the screen is off and the phone is plugged in`() {
    assertNull(BackgroundConditions.pauseReason(idle))
  }

  @Test
  fun `waits while the phone is in use`() {
    assertEquals(BackgroundPause.SCREEN_ON, BackgroundConditions.pauseReason(idle.copy(isInteractive = true)))
  }

  @Test
  fun `waits while the phone is not plugged in`() {
    assertEquals(BackgroundPause.NOT_CHARGING, BackgroundConditions.pauseReason(idle.copy(isPluggedIn = false)))
  }

  @Test
  fun `waits while the phone saves power`() {
    assertEquals(BackgroundPause.POWER_SAVE, BackgroundConditions.pauseReason(idle.copy(isPowerSaveMode = true)))
  }

  @Test
  fun `waits while the phone is too hot, not while it is only warm`() {
    assertNull(BackgroundConditions.pauseReason(idle.copy(thermalStatus = PowerManager.THERMAL_STATUS_MODERATE)))
    assertEquals(
      BackgroundPause.HOT,
      BackgroundConditions.pauseReason(idle.copy(thermalStatus = PowerManager.THERMAL_STATUS_SEVERE)),
    )
    assertEquals(
      BackgroundPause.HOT,
      BackgroundConditions.pauseReason(idle.copy(thermalStatus = PowerManager.THERMAL_STATUS_SHUTDOWN)),
    )
  }

  @Test
  fun `tells the first reason to wait`() {
    val busy = DeviceState(
      isInteractive = true,
      isPluggedIn = false,
      isPowerSaveMode = true,
      thermalStatus = PowerManager.THERMAL_STATUS_CRITICAL,
    )
    assertEquals(BackgroundPause.SCREEN_ON, BackgroundConditions.pauseReason(busy))
  }
}

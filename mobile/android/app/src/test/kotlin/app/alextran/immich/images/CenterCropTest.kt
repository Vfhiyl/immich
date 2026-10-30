package app.alextran.immich.images

import org.junit.Assert.assertEquals
import org.junit.Test

class CenterCropTest {
  @Test
  fun `the middle of a long screenshot as wide as it, for a square tile`() {
    assertEquals(1080 to 1080, centerCrop(1080, 20000, 320, 320))
  }

  @Test
  fun `the middle of a panorama as high as it`() {
    assertEquals(2832 to 2832, centerCrop(6336, 2832, 180, 180))
  }

  @Test
  fun `the aspect of the tile`() {
    assertEquals(1000 to 500, centerCrop(1000, 4000, 200, 100))
  }
}

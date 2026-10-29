package app.alextran.immich.images

import org.junit.Assert.assertEquals
import org.junit.Test

class RegionSampleTest {
  @Test
  fun `decodes a photo of 200 MP for the viewer's base at least as large as asked`() {
    // 12240 x 16320 for 1172 x 1563: 10 times smaller is 1224 x 1632
    assertEquals(10, regionSample(12240, 16320, 1172, 1563))
  }

  @Test
  fun `matches long sides and short sides, whichever way round the sizes are`() {
    assertEquals(10, regionSample(16320, 12240, 1172, 1563))
    assertEquals(10, regionSample(12240, 16320, 1563, 1172))
  }

  @Test
  fun `keeps the side that would be too small`() {
    // a long screenshot: its width decides
    assertEquals(4, regionSample(2160, 40000, 540, 4096))
  }

  @Test
  fun `never enlarges`() {
    assertEquals(1, regionSample(1000, 800, 1440, 1920))
    assertEquals(1, regionSample(1000, 800, 0, 0))
  }
}

package app.alextran.immich.images

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class CopyAtMostTest {
  @Test
  fun `copies a response of at most the limit`() {
    val data = ByteArray(20_000) { it.toByte() }
    val output = ByteArrayOutputStream()

    assertEquals(20_000L, copyAtMost(ByteArrayInputStream(data), output, 20_000))
    assertArrayEquals(data, output.toByteArray())
  }

  @Test
  fun `fails on a response larger than the limit, having written no more than it`() {
    val output = ByteArrayOutputStream()

    assertThrows(IOException::class.java) { copyAtMost(ByteArrayInputStream(ByteArray(20_001)), output, 20_000) }
    assert(output.size() <= 20_000)
  }
}

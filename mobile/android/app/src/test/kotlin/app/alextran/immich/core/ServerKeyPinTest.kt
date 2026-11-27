package app.alextran.immich.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.X509TrustManager

/** Two certificates as the server makes them in self-signed mode (server/src/utils/tls.ts), with their pins */
private val serverCertificate = certificate(
  """
      -----BEGIN CERTIFICATE-----
      MIIBZzCCAQ6gAwIBAgIQFTOl3+ByNek4GgINmhn9bjAKBggqhkjOPQQDAjARMQ8w
      DQYDVQQDEwZJbW1pY2gwHhcNMjYxMTI2MTYwMDQ2WhcNMjkwMjI4MTYwMDQ2WjAR
      MQ8wDQYDVQQDEwZJbW1pY2gwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQwP9fV
      dGz69JdOt3jnRdhUKMac4kvBm5FEre65FjL1br/3dvVfr6Kb9KpbdFU2LxSxCzPE
      0PQ2GNrMw7ADNQNCo0gwRjAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDAT
      BgNVHSUEDDAKBggrBgEFBQcDATARBgNVHREECjAIggZpbW1pY2gwCgYIKoZIzj0E
      AwIDRwAwRAIgTJrDY1NO0uLLsNsEwo4UOKEtLC8majQMbg8jgqfo7TgCICuIBf9a
      ekhGkeM/GYxRQ5rFeC4DtOBDJrQyTvhqJLv4
      -----END CERTIFICATE-----
  """.trimIndent()
)
private const val SERVER_PIN = "1+itYykaaOb6Rwpcyfl6q1PWCF9QuW1eelos1YewnSs="
private val otherCertificate = certificate(
  """
      -----BEGIN CERTIFICATE-----
      MIIBZzCCAQ6gAwIBAgIQGy05bG6S3PGw51hiJlQWrzAKBggqhkjOPQQDAjARMQ8w
      DQYDVQQDEwZJbW1pY2gwHhcNMjYxMTI2MTYwMDQ2WhcNMjkwMjI4MTYwMDQ2WjAR
      MQ8wDQYDVQQDEwZJbW1pY2gwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAReuRQc
      aVj4KooiqnGumXHdDwI+f2IdMPY2HJmpreVjP5XxFhwyYBIhw5L9AS1RZCKAPUCG
      1JUgTKm6zIzzvdNTo0gwRjAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDAT
      BgNVHSUEDDAKBggrBgEFBQcDATARBgNVHREECjAIggZpbW1pY2gwCgYIKoZIzj0E
      AwIDRwAwRAIgdslO9F3WqQa8Payqi9G+44iFvwcxAeN/xkFDXKgegBwCIDq8zWER
      u8frOFoi5ka3EITsDw6JPlsQm7gz1YPpcCJ+
      -----END CERTIFICATE-----
  """.trimIndent()
)

private fun certificate(pem: String) =
  CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream()) as X509Certificate

/** A system trust that trusts nothing, and says so */
private object Distrust : X509TrustManager {
  override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) = throw CertificateException("client")
  override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) = throw CertificateException("system")
  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

class ServerKeyPinTest {
  private val pin = ServerKeyPin("203.0.113.7", 2283, SERVER_PIN)
  private val sut = PinningTrustManager(Distrust) { pin }

  @Test
  fun `the pin of a certificate is the SHA-256 of its public key, as the server computes it`() {
    assertEquals(SERVER_PIN, ServerKeyPin.pinOf(serverCertificate))
  }

  @Test
  fun `the pinned server is trusted by its key, without a certificate authority`() {
    assertTrue(sut.checkPinned(arrayOf(serverCertificate), "203.0.113.7", 2283))
  }

  @Test
  fun `the pinned server is not trusted with another key`() {
    assertThrows(CertificateException::class.java) {
      sut.checkPinned(arrayOf(otherCertificate), "203.0.113.7", 2283)
    }
    assertThrows(CertificateException::class.java) { sut.checkPinned(arrayOf(), "203.0.113.7", 2283) }
  }

  @Test
  fun `other servers are left to the system`() {
    assertFalse(sut.checkPinned(arrayOf(otherCertificate), "photos.example.com", 2283))
    assertFalse(sut.checkPinned(arrayOf(otherCertificate), "203.0.113.7", 443))
    assertFalse(PinningTrustManager(Distrust) { null }.checkPinned(arrayOf(serverCertificate), "203.0.113.7", 2283))
    // without a socket, the system decides
    assertThrows(CertificateException::class.java) { sut.checkServerTrusted(arrayOf(serverCertificate), "ECDHE_ECDSA") }
  }

  @Test
  fun `a pin is for an HTTPS server, by its host and port`() {
    assertEquals(ServerKeyPin("203.0.113.7", 2283, "p"), ServerKeyPin.of("https://203.0.113.7:2283", "p"))
    assertEquals(ServerKeyPin("photos.example.com", 443, "p"), ServerKeyPin.of("https://photos.example.com/api", "p"))
    assertTrue(ServerKeyPin.of("https://PHOTOS.example.com", "p")!!.isFor("photos.example.com", 443))
    assertNull(ServerKeyPin.of("http://203.0.113.7:2283", "p"))
    assertNull(ServerKeyPin.of("not a url", "p"))
  }
}

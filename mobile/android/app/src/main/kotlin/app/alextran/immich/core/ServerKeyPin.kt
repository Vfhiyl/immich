package app.alextran.immich.core

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.Socket
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSession
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509ExtendedTrustManager
import javax.net.ssl.X509TrustManager

/**
 * A server whose key the app trusts instead of a certificate authority (self-signed mode, docs:
 * administration/self-signed-tls): the SHA-256 of its public key (SubjectPublicKeyInfo, base64) from the QR code that
 * signed the phone in. The pin holds for the server's host and port, by whatever address that is.
 */
data class ServerKeyPin(val host: String, val port: Int, val pin: String) {
  fun isFor(host: String?, port: Int) = host != null && host.equals(this.host, ignoreCase = true) && port == this.port

  companion object {
    /** The pin of an HTTPS server URL, or null for any other URL */
    fun of(url: String, pin: String): ServerKeyPin? =
      url.toHttpUrlOrNull()?.takeIf { it.isHttps }?.let { ServerKeyPin(it.host, it.port, pin) }

    /** SHA-256 of the public key of a certificate, base64 (as the server computes it) */
    fun pinOf(certificate: X509Certificate): String =
      Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded))
  }
}

/**
 * The system's trust, except for the pinned server: its connections are trusted when the server's certificate has the
 * pinned key, and only then (whatever the certificate authorities say; its certificate is its own).
 */
class PinningTrustManager(
  private val system: X509TrustManager,
  private val pinned: () -> ServerKeyPin?,
) : X509ExtendedTrustManager() {
  /** Whether the connection is to the pinned server, whose key it then checks; false for any other server */
  fun checkPinned(chain: Array<X509Certificate>?, host: String?, port: Int): Boolean {
    val pin = pinned()?.takeIf { it.isFor(host, port) } ?: return false
    val leaf = chain?.firstOrNull() ?: throw CertificateException("$host:$port sent no certificate")
    if (!MessageDigest.isEqual(ServerKeyPin.pinOf(leaf).toByteArray(), pin.pin.toByteArray())) {
      throw CertificateException("The key of $host:$port is not the one of the QR code it was signed in with")
    }
    return true
  }

  override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?, socket: Socket?) {
    val session = (socket as? SSLSocket)?.handshakeSession
    if (checkPinned(chain, session?.peerHost, session?.peerPort ?: -1)) return
    (system as? X509ExtendedTrustManager)?.checkServerTrusted(chain, authType, socket)
      ?: system.checkServerTrusted(chain, authType)
  }

  override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?, engine: SSLEngine?) {
    val session = engine?.handshakeSession
    if (checkPinned(chain, session?.peerHost, session?.peerPort ?: -1)) return
    (system as? X509ExtendedTrustManager)?.checkServerTrusted(chain, authType, engine)
      ?: system.checkServerTrusted(chain, authType)
  }

  // without a socket there is no server to tell: the system decides
  override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) =
    system.checkServerTrusted(chain, authType)

  override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?, socket: Socket?) =
    system.checkClientTrusted(chain, authType)

  override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?, engine: SSLEngine?) =
    system.checkClientTrusted(chain, authType)

  override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) =
    system.checkClientTrusted(chain, authType)

  override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
}

/**
 * The system's check of the host name, except for the pinned server, whose certificate names no host (it is reached
 * by any address): its key must be the pinned one instead (checked again here, for sessions that were resumed).
 */
class PinningHostnameVerifier(
  private val system: HostnameVerifier,
  private val pinned: () -> ServerKeyPin?,
) : HostnameVerifier {
  override fun verify(hostname: String?, session: SSLSession): Boolean {
    val pin = pinned()?.takeIf { it.isFor(hostname, session.peerPort) } ?: return system.verify(hostname, session)
    val leaf = session.peerCertificates.firstOrNull() as? X509Certificate ?: return false
    return MessageDigest.isEqual(ServerKeyPin.pinOf(leaf).toByteArray(), pin.pin.toByteArray())
  }
}

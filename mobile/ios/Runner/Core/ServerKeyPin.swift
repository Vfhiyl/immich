import CryptoKit
import Foundation
import Security

let PINNED_SERVER_KEY = "immich.pinned_server"

/// A server whose key the app trusts instead of a certificate authority (self-signed mode, docs:
/// administration/self-signed-tls): the SHA-256 of its public key (SubjectPublicKeyInfo, base64) from the QR code
/// that signed the phone in, for the server's host and port.
struct ServerKeyPin: Equatable {
  let host: String
  let port: Int
  let pin: String

  init?(url: String, pin: String) {
    guard let components = URLComponents(string: url), components.scheme == "https", let host = components.host,
      !host.isEmpty
    else { return nil }
    self.host = host.lowercased()
    self.port = components.port ?? 443
    self.pin = pin
  }

  func isFor(host: String, port: Int) -> Bool {
    return host.lowercased() == self.host && port == self.port
  }

  /// The pinned server, as the app stored it
  static var current: ServerKeyPin? {
    guard let stored = UserDefaults.group.string(forKey: PINNED_SERVER_KEY) else { return nil }
    let parts = stored.split(separator: " ", maxSplits: 1).map(String.init)
    return parts.count == 2 ? ServerKeyPin(url: parts[0], pin: parts[1]) : nil
  }

  static func store(url: String?, pin: String?) throws {
    guard let url = url, let pin = pin else {
      UserDefaults.group.removeObject(forKey: PINNED_SERVER_KEY)
      return
    }
    guard ServerKeyPin(url: url, pin: pin) != nil else {
      throw PigeonError(code: "INVALID", message: "Only an HTTPS server has a key to trust", details: nil)
    }
    UserDefaults.group.set("\(url) \(pin)", forKey: PINNED_SERVER_KEY)
  }

  /// The DER prefix of the SubjectPublicKeyInfo of a P-256 key (the server's), before the point of the key
  private static let p256Prefix: [UInt8] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
    0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ]

  /// SHA-256 of the SubjectPublicKeyInfo of a certificate's key, base64, as the server computes it (P-256 keys only,
  /// which the server makes)
  static func pin(of certificate: SecCertificate) -> String? {
    guard let key = SecCertificateCopyKey(certificate),
      let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
      attributes[kSecAttrKeyType] as? String == (kSecAttrKeyTypeECSECPrimeRandom as String),
      attributes[kSecAttrKeySizeInBits] as? Int == 256,
      let point = SecKeyCopyExternalRepresentation(key, nil) as Data?
    else { return nil }
    let spki = Data(p256Prefix) + point
    return Data(SHA256.hash(data: spki)).base64EncodedString()
  }

  /// Whether the server of the challenge is the pinned one, and then its trust: only with the pinned key
  static func evaluate(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?)? {
    let space = challenge.protectionSpace
    guard let pinned = current, pinned.isFor(host: space.host, port: space.port) else { return nil }
    guard let trust = space.serverTrust,
      let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first,
      let actual = pin(of: leaf),
      actual == pinned.pin
    else { return (.cancelAuthenticationChallenge, nil) }
    return (.useCredential, URLCredential(trust: trust))
  }
}

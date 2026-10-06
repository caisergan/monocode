import CryptoKit
import Foundation

// Noise_IK_25519_ChaChaPoly_SHA256 (Noise spec rev 34), specialised to the one
// pattern MonoCode uses (03 §3.4):
//
//   <- s
//   ...
//   -> e, es, s, ss     (phone → host, payload: hello)
//   <- e, ee, se        (host → phone, payload: welcome or error)
//
// Verified against the cacophony and snow test vectors (NoiseTests).

public let noiseProtocolName = "Noise_IK_25519_ChaChaPoly_SHA256"
public let maxNoiseMessage = 65_535
public let dhLength = 32
public let tagLength = 16

public enum NoiseError: Error, Equatable, Sendable {
  case invalidKey
  /// Authentication failed: a wrong key or prologue, tampering, or a
  /// replayed, dropped or reordered message. Close the channel.
  case decryptFailed
  case nonceExhausted
  case messageTooShort
  case messageTooLarge
  /// A handshake step was called out of order.
  case unexpectedMessage
}

/// An X25519 key pair as raw 32-byte keys.
public struct KeyPair: Hashable, Sendable {
  public let publicKey: Data
  public let secretKey: Data

  public static func generate() -> KeyPair {
    let key = Curve25519.KeyAgreement.PrivateKey()
    return KeyPair(publicKey: key.publicKey.rawRepresentation, secretKey: key.rawRepresentation)
  }

  public init(secretKey: Data) throws {
    guard secretKey.count == dhLength,
      let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secretKey)
    else { throw NoiseError.invalidKey }
    self.secretKey = secretKey
    publicKey = key.publicKey.rawRepresentation
  }

  private init(publicKey: Data, secretKey: Data) {
    self.publicKey = publicKey
    self.secretKey = secretKey
  }

  func dh(_ publicKey: Data) throws -> Data {
    do {
      let mine = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secretKey)
      let theirs = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
      return try mine.sharedSecretFromKeyAgreement(with: theirs).withUnsafeBytes { Data($0) }
    } catch {
      throw NoiseError.invalidKey
    }
  }
}

/// 32 bits of zeros followed by the little-endian 64-bit counter.
private func nonce(_ n: UInt64) -> ChaChaPoly.Nonce {
  var bytes = Data(count: 4)
  withUnsafeBytes(of: n.littleEndian) { bytes.append(contentsOf: $0) }
  return try! ChaChaPoly.Nonce(data: bytes)
}

/// Noise's HKDF with two outputs: RFC 5869 with the chaining key as salt and
/// empty info.
private func hkdf2(_ chainingKey: Data, _ input: Data) -> (Data, Data) {
  let output = HKDF<SHA256>.deriveKey(
    inputKeyMaterial: SymmetricKey(data: input), salt: chainingKey, info: Data(), outputByteCount: 64
  ).withUnsafeBytes { Data($0) }
  return (output.prefix(32), output.suffix(32))
}

private func sha256(_ data: Data) -> Data {
  Data(SHA256.hash(data: data))
}

/// One direction of a Noise channel. A value type: copy it only to inspect.
public struct CipherState: Sendable {
  private let key: SymmetricKey?
  private var n: UInt64 = 0

  init(key: Data? = nil) {
    self.key = key.map { SymmetricKey(data: $0) }
  }

  public var hasKey: Bool { key != nil }

  /// Messages sent or received so far.
  public var count: UInt64 { n }

  public mutating func encrypt(_ plaintext: Data, ad: Data = Data()) throws -> Data {
    guard let key else { return plaintext }
    // 2^64 - 1 is reserved (Noise §5.1).
    if n == .max { throw NoiseError.nonceExhausted }
    let box = try ChaChaPoly.seal(plaintext, using: key, nonce: nonce(n), authenticating: ad)
    n += 1
    return box.ciphertext + box.tag
  }

  /// Throws when authentication fails, without advancing the counter. The
  /// caller must then close the channel.
  public mutating func decrypt(_ ciphertext: Data, ad: Data = Data()) throws -> Data {
    guard let key else { return ciphertext }
    if n == .max { throw NoiseError.nonceExhausted }
    guard ciphertext.count >= tagLength else { throw NoiseError.decryptFailed }
    let plaintext: Data
    do {
      let box = try ChaChaPoly.SealedBox(
        nonce: nonce(n), ciphertext: ciphertext.prefix(ciphertext.count - tagLength), tag: ciphertext.suffix(tagLength)
      )
      plaintext = try ChaChaPoly.open(box, using: key, authenticating: ad)
    } catch {
      throw NoiseError.decryptFailed
    }
    n += 1
    return plaintext
  }
}

struct SymmetricState: Sendable {
  var h: Data
  private var ck: Data
  private var cipher = CipherState()

  init() {
    let name = Data(noiseProtocolName.utf8)
    h = name.count <= 32 ? name + Data(count: 32 - name.count) : sha256(name)
    ck = h
  }

  mutating func mixKey(_ input: Data) {
    let (ck, key) = hkdf2(ck, input)
    self.ck = ck
    cipher = CipherState(key: key)
  }

  mutating func mixHash(_ data: Data) {
    h = sha256(h + data)
  }

  mutating func encryptAndHash(_ plaintext: Data) throws -> Data {
    let ciphertext = try cipher.encrypt(plaintext, ad: h)
    mixHash(ciphertext)
    return ciphertext
  }

  mutating func decryptAndHash(_ ciphertext: Data) throws -> Data {
    let plaintext = try cipher.decrypt(ciphertext, ad: h)
    mixHash(ciphertext)
    return plaintext
  }

  func split() -> (CipherState, CipherState) {
    let (first, second) = hkdf2(ck, Data())
    return (CipherState(key: first), CipherState(key: second))
  }
}

/// A completed handshake: one cipher per direction, plus the handshake hash
/// that names this channel (pairing proof, confirmation code).
public struct NoiseTransport: Sendable {
  public var send: CipherState
  public var receive: CipherState
  public let handshakeHash: Data
  public let remoteStatic: Data
}

/// The phone's side of the handshake.
public struct IKInitiator: Sendable {
  private var state = SymmetricState()
  private let staticKey: KeyPair
  private let remoteStatic: Data
  private let fixedEphemeral: KeyPair?
  private var ephemeral: KeyPair?
  private var done = false

  /// `ephemeral` is for tests only: a fixed ephemeral key.
  public init(staticKey: KeyPair, remoteStatic: Data, prologue: Data, ephemeral: KeyPair? = nil) throws {
    guard remoteStatic.count == dhLength else { throw NoiseError.invalidKey }
    self.staticKey = staticKey
    self.remoteStatic = remoteStatic
    fixedEphemeral = ephemeral
    state.mixHash(prologue)
    state.mixHash(remoteStatic)
  }

  /// -> e, es, s, ss
  public mutating func writeMessage1(_ payload: Data) throws -> Data {
    if ephemeral != nil { throw NoiseError.unexpectedMessage }
    let e = fixedEphemeral ?? .generate()
    ephemeral = e
    state.mixHash(e.publicKey)
    state.mixKey(try e.dh(remoteStatic))
    let encryptedStatic = try state.encryptAndHash(staticKey.publicKey)
    state.mixKey(try staticKey.dh(remoteStatic))
    let encryptedPayload = try state.encryptAndHash(payload)
    let message = e.publicKey + encryptedStatic + encryptedPayload
    if message.count > maxNoiseMessage { throw NoiseError.messageTooLarge }
    return message
  }

  /// <- e, ee, se
  public mutating func readMessage2(_ message: Data) throws -> (payload: Data, transport: NoiseTransport) {
    guard let ephemeral, !done else { throw NoiseError.unexpectedMessage }
    guard message.count >= dhLength + tagLength else { throw NoiseError.messageTooShort }
    let bytes = Data(message)
    let re = bytes.prefix(dhLength)
    state.mixHash(re)
    state.mixKey(try ephemeral.dh(re))
    state.mixKey(try staticKey.dh(re))
    let payload = try state.decryptAndHash(bytes.dropFirst(dhLength))
    let (initiatorToResponder, responderToInitiator) = state.split()
    done = true
    return (
      payload,
      NoiseTransport(
        send: initiatorToResponder, receive: responderToInitiator, handshakeHash: state.h, remoteStatic: remoteStatic
      )
    )
  }
}

/// The host's side of the handshake: the demo host and tests use it.
public struct IKResponder: Sendable {
  private var state = SymmetricState()
  private let staticKey: KeyPair
  private let fixedEphemeral: KeyPair?
  private var remoteEphemeral: Data?
  private var remoteStatic: Data?
  private var done = false

  /// `ephemeral` is for tests only: a fixed ephemeral key.
  public init(staticKey: KeyPair, prologue: Data, ephemeral: KeyPair? = nil) {
    self.staticKey = staticKey
    fixedEphemeral = ephemeral
    state.mixHash(prologue)
    state.mixHash(staticKey.publicKey)
  }

  /// Throws when the message was not made for this host key and prologue.
  public mutating func readMessage1(_ message: Data) throws -> (payload: Data, remoteStatic: Data) {
    if remoteEphemeral != nil { throw NoiseError.unexpectedMessage }
    guard message.count >= 2 * dhLength + 2 * tagLength else { throw NoiseError.messageTooShort }
    let bytes = Data(message)
    let re = bytes.prefix(dhLength)
    remoteEphemeral = re
    state.mixHash(re)
    state.mixKey(try staticKey.dh(re))
    let rs = try state.decryptAndHash(bytes[dhLength..<(2 * dhLength + tagLength)])
    remoteStatic = rs
    state.mixKey(try staticKey.dh(rs))
    let payload = try state.decryptAndHash(bytes.dropFirst(2 * dhLength + tagLength))
    return (payload, rs)
  }

  /// <- e, ee, se
  public mutating func writeMessage2(_ payload: Data) throws -> (message: Data, transport: NoiseTransport) {
    guard let remoteEphemeral, let remoteStatic, !done else { throw NoiseError.unexpectedMessage }
    let e = fixedEphemeral ?? .generate()
    state.mixHash(e.publicKey)
    state.mixKey(try e.dh(remoteEphemeral))
    state.mixKey(try e.dh(remoteStatic))
    let encryptedPayload = try state.encryptAndHash(payload)
    let message = e.publicKey + encryptedPayload
    if message.count > maxNoiseMessage { throw NoiseError.messageTooLarge }
    let (initiatorToResponder, responderToInitiator) = state.split()
    done = true
    return (
      message,
      NoiseTransport(
        send: responderToInitiator, receive: initiatorToResponder, handshakeHash: state.h, remoteStatic: remoteStatic
      )
    )
  }
}

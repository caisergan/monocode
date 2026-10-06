import CryptoKit
import Foundation

// Pairing proof, confirmation code and host fingerprint (03 §3.2, §3.6).

/// HMAC-SHA256(secret, "monocode/pair/1" || h)
public func pairingProof(secret: Data, handshakeHash: Data) -> Data {
  Data(HMAC<SHA256>.authenticationCode(for: Data("monocode/pair/1".utf8) + handshakeHash, using: SymmetricKey(data: secret)))
}

public func verifyPairingProof(secret: Data, handshakeHash: Data, proof: Data) -> Bool {
  constantTimeEqual(pairingProof(secret: secret, handshakeHash: handshakeHash), proof)
}

/// Six digits both screens show; equal codes mean the same channel.
public func confirmationCode(handshakeHash: Data) -> String {
  let digest = Array(SHA256.hash(data: Data("monocode/sas/1".utf8) + handshakeHash))
  let value = digest[0..<4].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
  let digits = String(value % 1_000_000)
  return String(repeating: "0", count: 6 - digits.count) + digits
}

/// "482913" → "482 913"
public func formatCode(_ code: String) -> String {
  "\(code.prefix(3)) \(code.dropFirst(3))"
}

/// First 20 bytes of SHA-256(host key), Crockford base32, in groups of four.
public func hostFingerprint(_ hostPublicKey: Data) -> String {
  let text = Array(Data(SHA256.hash(data: hostPublicKey).prefix(20)).crockford)
  return stride(from: 0, to: text.count, by: 4).map { String(text[$0..<min($0 + 4, text.count)]) }
    .joined(separator: "-")
}

/// Short id shown in logs and lists, never the full key.
public func keyHash(_ publicKey: Data) -> Data {
  Data(SHA256.hash(data: publicKey))
}

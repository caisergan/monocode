import Foundation
import MonoChannel
import Testing

struct PairingFixtures: Decodable {
  let proofs: [Proof]
  let fingerprints: [Fingerprint]
  let encodings: [Encoding]

  struct Proof: Decodable {
    let secret, h, proof, code, formatted: String
  }

  struct Fingerprint: Decodable {
    let key, fingerprint, keyHash: String
  }

  struct Encoding: Decodable {
    let hex, base64url, crockford: String
  }
}

@Suite struct PairingTests {
  let fixtures: PairingFixtures

  init() throws {
    fixtures = try fixture("pairing")
  }

  @Test func proofsAndCodes() throws {
    #expect(fixtures.proofs.contains { $0.code.hasPrefix("0") })
    for case_ in fixtures.proofs {
      let secret = try hex(case_.secret)
      let h = try hex(case_.h)
      let proof = pairingProof(secret: secret, handshakeHash: h)
      #expect(proof.hex == case_.proof)
      #expect(verifyPairingProof(secret: secret, handshakeHash: h, proof: proof))
      var other = h
      other[0] ^= 1
      #expect(!verifyPairingProof(secret: secret, handshakeHash: other, proof: proof))
      #expect(!verifyPairingProof(secret: secret, handshakeHash: h, proof: proof.prefix(31)))
      #expect(confirmationCode(handshakeHash: h) == case_.code)
      #expect(formatCode(case_.code) == case_.formatted)
    }
  }

  @Test func fingerprints() throws {
    for case_ in fixtures.fingerprints {
      let key = try hex(case_.key)
      #expect(hostFingerprint(key) == case_.fingerprint)
      #expect(keyHash(key).hex == case_.keyHash)
    }
  }

  @Test func encodings() throws {
    for case_ in fixtures.encodings {
      let bytes = try hex(case_.hex)
      #expect(bytes.hex == case_.hex)
      #expect(bytes.base64URL == case_.base64url)
      #expect(try Data(base64URL: case_.base64url) == bytes)
      #expect(bytes.crockford == case_.crockford)
    }
    // Standard base64 and padding decode too; anything else throws.
    #expect(try Data(base64URL: "+/8=") == Data([0xFB, 0xFF, 0xFF].prefix(2)))
    #expect(throws: BytesError.invalidBase64URL) { try Data(base64URL: "a$b") }
    #expect(throws: BytesError.invalidBase64URL) { try Data(base64URL: "abcde") }
    #expect(throws: BytesError.invalidHex) { try Data(hex: "abc") }
    #expect(throws: BytesError.invalidHex) { try Data(hex: "zz") }
  }
}

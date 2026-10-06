import Foundation

// Byte helpers matching packages/channel/src/bytes.ts, so keys, offers and
// fingerprints read and print the same on both sides.

public enum BytesError: Error, Equatable, Sendable {
  case invalidBase64URL
  case invalidHex
}

private let base64URLAlphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)

private let base64URLLookup: [Int8] = {
  var table = [Int8](repeating: -1, count: 128)
  for (index, code) in base64URLAlphabet.enumerated() { table[Int(code)] = Int8(index) }
  // Accept standard base64 too, so pasted values decode either way.
  table[Int(UInt8(ascii: "+"))] = 62
  table[Int(UInt8(ascii: "/"))] = 63
  return table
}()

extension Data {
  /// Unpadded base64url.
  public var base64URL: String {
    var out = [UInt8]()
    out.reserveCapacity((count * 4 + 2) / 3)
    let bytes = [UInt8](self)
    var i = 0
    while i + 2 < bytes.count {
      let n = Int(bytes[i]) << 16 | Int(bytes[i + 1]) << 8 | Int(bytes[i + 2])
      out += [n >> 18, (n >> 12) & 63, (n >> 6) & 63, n & 63].map { base64URLAlphabet[$0] }
      i += 3
    }
    if i < bytes.count {
      let n = Int(bytes[i]) << 16 | (i + 1 < bytes.count ? Int(bytes[i + 1]) << 8 : 0)
      out += [n >> 18, (n >> 12) & 63].map { base64URLAlphabet[$0] }
      if i + 1 < bytes.count { out.append(base64URLAlphabet[(n >> 6) & 63]) }
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// Decodes base64url or standard base64. Trailing padding is ignored; any
  /// other character outside the two alphabets throws.
  public init(base64URL text: String) throws {
    var units = Array(text.utf16)
    while units.last == 0x3D { units.removeLast() }
    if units.count % 4 == 1 { throw BytesError.invalidBase64URL }
    var out = [UInt8]()
    out.reserveCapacity(units.count * 3 / 4)
    var bits = 0
    var value = 0
    for unit in units {
      let digit = unit < 128 ? Int(base64URLLookup[Int(unit)]) : -1
      if digit < 0 { throw BytesError.invalidBase64URL }
      value = (value << 6 | digit) & 0xFFFFFF
      bits += 6
      if bits >= 8 {
        bits -= 8
        out.append(UInt8((value >> bits) & 0xFF))
      }
    }
    self.init(out)
  }

  /// Lowercase hex.
  public var hex: String {
    let digits = Array("0123456789abcdef".utf8)
    var out = [UInt8]()
    out.reserveCapacity(count * 2)
    for byte in self {
      out.append(digits[Int(byte >> 4)])
      out.append(digits[Int(byte & 15)])
    }
    return String(decoding: out, as: UTF8.self)
  }

  public init(hex: String) throws {
    let units = Array(hex.utf8)
    if units.count % 2 != 0 { throw BytesError.invalidHex }
    func nibble(_ unit: UInt8) throws -> UInt8 {
      switch unit {
      case UInt8(ascii: "0")...UInt8(ascii: "9"): unit - UInt8(ascii: "0")
      case UInt8(ascii: "a")...UInt8(ascii: "f"): unit - UInt8(ascii: "a") + 10
      case UInt8(ascii: "A")...UInt8(ascii: "F"): unit - UInt8(ascii: "A") + 10
      default: throw BytesError.invalidHex
      }
    }
    var out = [UInt8]()
    out.reserveCapacity(units.count / 2)
    for i in stride(from: 0, to: units.count, by: 2) {
      out.append(try nibble(units[i]) << 4 | nibble(units[i + 1]))
    }
    self.init(out)
  }

  /// Crockford base32, used for human-readable fingerprints.
  public var crockford: String {
    let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ".utf8)
    var out = [UInt8]()
    var bits = 0
    var value = 0
    for byte in self {
      value = value << 8 | Int(byte)
      bits += 8
      while bits >= 5 {
        bits -= 5
        out.append(alphabet[(value >> bits) & 31])
      }
      value &= (1 << bits) - 1
    }
    if bits > 0 { out.append(alphabet[(value << (5 - bits)) & 31]) }
    return String(decoding: out, as: UTF8.self)
  }
}

/// Compares in time that depends only on the lengths.
public func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
  guard a.count == b.count else { return false }
  var difference: UInt8 = 0
  for (x, y) in zip(a, b) { difference |= x ^ y }
  return difference == 0
}

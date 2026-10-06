import Foundation

// Pairing offers (04 §4.2): the JSON a QR code or link carries. The rules
// follow packages/channel/src/offer.ts check for check, including what it
// skips silently rather than rejects.

/// The appearance of the desktop that created the offer (11 §11.2).
public struct OfferAppearance: Codable, Hashable, Sendable {
  /// "dark", "light" or "system".
  public var theme: String
  public var hue: Double
  public var sat: Double
  public var dark: Double
  public var accent: String?
}

public struct Offer: Codable, Hashable, Sendable {
  public var v: Int
  public var env: String
  public var name: String
  /// The host key, base64url of 32 bytes.
  public var key: String
  /// The offer id, base64url of 16 bytes.
  public var offer: String
  /// The pairing secret, base64url of 32 bytes.
  public var secret: String
  /// Unix seconds by host clock.
  public var exp: Double
  public var direct: [Endpoint]?
  public var relay: Relay?
  /// Passed through unchecked, as the TypeScript does; read it through `appearance`.
  public var ui: JSONValue?

  public init(
    env: String, name: String, key: String, offer: String, secret: String, exp: Double,
    direct: [Endpoint]? = nil, relay: Relay? = nil, ui: JSONValue? = nil
  ) {
    v = 1
    self.env = env
    self.name = name
    self.key = key
    self.offer = offer
    self.secret = secret
    self.exp = exp
    self.direct = direct
    self.relay = relay
    self.ui = ui
  }

  enum CodingKeys: String, CodingKey { case v, env, name, key, offer, secret, exp, direct, relay, ui }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    v = try c.decode(Int.self, forKey: .v)
    env = try c.decode(String.self, forKey: .env)
    name = try c.decode(String.self, forKey: .name)
    key = try c.decode(String.self, forKey: .key)
    offer = try c.decode(String.self, forKey: .offer)
    secret = try c.decode(String.self, forKey: .secret)
    exp = try c.decode(Double.self, forKey: .exp)
    direct = try c.decodeIfPresent([Endpoint].self, forKey: .direct)
    relay = try c.decodeIfPresent(Relay.self, forKey: .relay)
    ui = try c.decodeIfPresent(JSONValue.self, forKey: .ui)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(v, forKey: .v)
    try c.encode(env, forKey: .env)
    try c.encode(name, forKey: .name)
    try c.encode(key, forKey: .key)
    try c.encode(offer, forKey: .offer)
    try c.encode(secret, forKey: .secret)
    try c.encode(JSONValue.number(exp), forKey: .exp)
    try c.encodeIfPresent(direct, forKey: .direct)
    try c.encodeIfPresent(relay, forKey: .relay)
    try c.encodeIfPresent(ui, forKey: .ui)
  }

  /// The host key as bytes. Validation guarantees 32 of them.
  public var hostKey: Data { (try? Data(base64URL: key)) ?? Data() }
  public var offerId: Data { (try? Data(base64URL: offer)) ?? Data() }
  public var pairingSecret: Data { (try? Data(base64URL: secret)) ?? Data() }

  public var appearance: OfferAppearance? { try? ui?.decode(OfferAppearance.self) }

  /// Rule 5: an expired offer gets a warning, but the phone still tries,
  /// because the host clock decides.
  public func isExpired(now: Date = Date()) -> Bool {
    exp < now.timeIntervalSince1970
  }
}

public struct OfferError: Error, Equatable, Sendable, LocalizedError {
  public enum Reason: String, Sendable {
    case malformed, version
  }

  public let reason: Reason
  public let message: String

  public var errorDescription: String? { message }

  static let malformed = OfferError(reason: .malformed, message: "This isn't a MonoCode pairing code.")
  static let version = OfferError(reason: .version, message: "Update MonoCode to pair with this machine.")
}

let maxOfferJSON = 4096

/// `<linkBase>#o=<base64url(UTF-8 JSON)>`. The JSON's key order and number
/// formatting differ from `JSON.stringify`, so the link's bytes differ from
/// one the host makes; both parse to the same offer.
public func encodeOfferLink(_ offer: Offer, linkBase: String) throws -> String {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  return "\(linkBase)#o=\(try encoder.encode(offer).base64URL)"
}

/// Accepts any MonoCode pairing link (https, monocode://, monocode-dev://) or
/// the bare encoded offer. Validates before any network traffic.
public func parseOfferLink(_ text: String, allowInsecureRelay: Bool = false) throws(OfferError) -> Offer {
  // Scalars, not Characters: a combining mark must not hide a "#", "&" or "=".
  let trimmed = jsTrim(text).unicodeScalars
  let fragment = trimmed.firstIndex(of: "#").map { trimmed[trimmed.index(after: $0)...] } ?? trimmed[...]
  let parameter = fragment.split(separator: "&", omittingEmptySubsequences: false)
    .map { $0.split(separator: "=", omittingEmptySubsequences: false) }
    .first { String($0[0]) == "o" }
  let encoded: String? =
    if let parameter, parameter.count > 1 {
      String(parameter[1])
    } else {
      fragment.contains("=") ? nil : String(fragment)
    }
  guard let encoded, !encoded.isEmpty else { throw .malformed }
  let value: JSONValue
  do {
    let bytes = try Data(base64URL: encoded)
    if bytes.count > maxOfferJSON { throw OfferError.malformed }
    guard String(data: bytes, encoding: .utf8) != nil else { throw OfferError.malformed }
    value = try JSONDecoder().decode(JSONValue.self, from: bytes)
  } catch {
    throw .malformed
  }
  return try validateOffer(value, allowInsecureRelay: allowInsecureRelay)
}

/// Rules 1 to 4 of 04 §4.2. Rule 6 (pairing again with a known `env`)
/// belongs to the pairing flow, which knows the paired hosts.
public func validateOffer(_ value: JSONValue, allowInsecureRelay: Bool = false) throws(OfferError) -> Offer {
  guard case let .object(fields) = value else { throw .malformed }
  if fields["v"] != .number(1) { throw .version }
  guard let env = fields["env"]?.stringValue, isUUID(env) else { throw .malformed }
  guard isBytes(fields["key"], 32), isBytes(fields["secret"], 32), isBytes(fields["offer"], 16) else {
    throw .malformed
  }
  guard let exp = fields["exp"]?.numberValue, exp.isFinite else { throw .malformed }
  let name: String =
    if let raw = fields["name"]?.stringValue, case let trimmed = jsTrim(raw), !trimmed.isEmpty {
      String(utf16Prefix: trimmed, 64)
    } else {
      "Computer"
    }
  var direct: [Endpoint] = []
  if let raw = fields["direct"] {
    guard case let .array(entries) = raw else { throw .malformed }
    for entry in entries.prefix(8) {
      guard case let .object(entry) = entry,
        let kind = entry["kind"]?.stringValue.map(EndpointKind.init(rawValue:)),
        [.lan, .tailscale, .manual].contains(kind)
      else { continue }
      guard let addr = entry["addr"]?.stringValue, isAddress(addr) else { throw .malformed }
      guard let port = entry["port"]?.numberValue, port == port.rounded(), port >= 1, port <= 65_535 else {
        throw .malformed
      }
      var endpoint = Endpoint(kind: kind, addr: addr, port: Int(port))
      if kind == .tailscale, let dns = entry["dns"]?.stringValue, isHostname(dns) { endpoint.dns = dns }
      direct.append(endpoint)
    }
  }
  var relay: Relay?
  if let raw = fields["relay"] {
    guard let url = raw["url"]?.stringValue, let room = raw["room"]?.stringValue else { throw .malformed }
    let secure = url.hasPrefix("wss://")
    if !secure && !(allowInsecureRelay && url.hasPrefix("ws://")) { throw .malformed }
    relay = Relay(url: url, room: room)
  }
  if direct.isEmpty && relay == nil { throw .malformed }
  var ui: JSONValue?
  switch fields["ui"] {
  case let value?:
    if case .object = value { ui = value }
    if case .array = value { ui = value }
  case nil: break
  }
  return Offer(
    env: env, name: name, key: fields["key"]!.stringValue!, offer: fields["offer"]!.stringValue!,
    secret: fields["secret"]!.stringValue!, exp: exp, direct: direct.isEmpty ? nil : direct, relay: relay, ui: ui
  )
}

private func isBytes(_ value: JSONValue?, _ length: Int) -> Bool {
  guard let text = value?.stringValue, let bytes = try? Data(base64URL: text) else { return false }
  return bytes.count == length
}

private func isHex(_ unit: UInt8) -> Bool {
  (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(unit) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(unit)
    || (UInt8(ascii: "A")...UInt8(ascii: "F")).contains(unit)
}

/// `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, case-insensitive.
private func isUUID(_ text: String) -> Bool {
  let units = Array(text.utf8)
  guard units.count == 36 else { return false }
  for (i, unit) in units.enumerated() {
    if [8, 13, 18, 23].contains(i) {
      if unit != UInt8(ascii: "-") { return false }
    } else if !isHex(unit) {
      return false
    }
  }
  return true
}

/// `^[a-z0-9.-]{1,253}$`, case-insensitive.
private func isHostname(_ text: String) -> Bool {
  let units = Array(text.utf8)
  return (1...253).contains(units.count)
    && units.allSatisfy { isHex($0) || (UInt8(ascii: "a")...UInt8(ascii: "z")).contains($0 | 0x20) || $0 == 0x2E || $0 == 0x2D }
}

/// An IPv4 literal (each part ≤ 255), anything with a colon made of hex
/// digits, colons and dots (IPv6), or a hostname.
private func isAddress(_ addr: String) -> Bool {
  let parts = addr.split(separator: ".", omittingEmptySubsequences: false)
  if parts.count == 4,
    parts.allSatisfy({ (1...3).contains($0.utf8.count) && $0.utf8.allSatisfy { (0x30...0x39).contains($0) } })
  {
    return parts.allSatisfy { Int($0)! <= 255 }
  }
  if addr.contains(":") {
    return addr.utf8.allSatisfy { isHex($0) || $0 == 0x3A || $0 == 0x2E }
  }
  return isHostname(addr)
}

/// JavaScript's `String.prototype.trim` whitespace: WhiteSpace and LineTerminator.
private let jsWhitespace: Set<Unicode.Scalar> = {
  var scalars: Set<Unicode.Scalar> = [
    "\u{9}", "\u{A}", "\u{B}", "\u{C}", "\u{D}", " ", "\u{A0}", "\u{1680}", "\u{2028}", "\u{2029}", "\u{202F}",
    "\u{205F}", "\u{3000}", "\u{FEFF}",
  ]
  for value in 0x2000...0x200A { scalars.insert(Unicode.Scalar(value)!) }
  return scalars
}()

func jsTrim(_ text: String) -> String {
  let scalars = text.unicodeScalars
  guard let start = scalars.firstIndex(where: { !jsWhitespace.contains($0) }),
    let end = scalars.lastIndex(where: { !jsWhitespace.contains($0) })
  else { return "" }
  return String(scalars[start...end])
}

extension String {
  /// `text.slice(0, count)` in UTF-16 code units. A surrogate pair cut in
  /// half becomes U+FFFD, where JavaScript keeps the lone surrogate.
  init(utf16Prefix text: String, _ count: Int) {
    let units = text.utf16
    if units.count <= count {
      self = text
    } else {
      self = String(decoding: units.prefix(count), as: UTF16.self)
    }
  }
}

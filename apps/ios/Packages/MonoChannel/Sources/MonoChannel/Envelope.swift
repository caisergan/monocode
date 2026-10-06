import Foundation

// Wire types for channel 1 (06 §6.2, §6.3). Session-level shapes live in
// MonoWire; this file only knows the envelope and the handshake.
//
// Decoding is tolerant (16 §16.5): unknown fields are ignored, and the
// string-valued codes below accept values this build doesn't know, so a
// newer host doesn't break an older app.

public let channelVersion = 1

/// The first byte of every WebSocket message (03 §3.4).
public enum FrameKind: UInt8, Sendable {
  case handshake1 = 0x01
  case handshake2 = 0x02
  case transport = 0x03
  case reject = 0x04
}

/// The Noise prologue binds the channel to one host identity (03 §3.4).
public func channelPrologue(_ environmentId: String) -> Data {
  Data("monocode/channel/1\u{0}\(environmentId)".utf8)
}

/// A string code that keeps values this build doesn't know.
public protocol OpenCode: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral,
  CustomStringConvertible
where RawValue == String {
  init(rawValue: String)
}

extension OpenCode {
  public init(stringLiteral value: String) { self.init(rawValue: value) }
  public var description: String { rawValue }

  public init(from decoder: any Decoder) throws {
    self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

public struct EndpointKind: OpenCode {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let lan: Self = "lan"
  public static let tailscale: Self = "tailscale"
  public static let manual: Self = "manual"
}

/// A direct candidate (05 §5.2). `dns` is set on tailscale endpoints only.
public struct Endpoint: Codable, Hashable, Sendable {
  public var kind: EndpointKind
  public var addr: String
  public var port: Int
  public var dns: String?

  public init(kind: EndpointKind, addr: String, port: Int, dns: String? = nil) {
    self.kind = kind
    self.addr = addr
    self.port = port
    self.dns = dns
  }
}

public struct Presence: Codable, Hashable, Sendable {
  public var visible: Bool
  public var focusedSessionId: String?

  public init(visible: Bool, focusedSessionId: String? = nil) {
    self.visible = visible
    self.focusedSessionId = focusedSessionId
  }
}

public struct ClientCap: OpenCode {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let deflate: Self = "deflate"
  public static let attention: Self = "attention"
  public static let windowedSync: Self = "windowedSync"
  public static let truncatedBlocks: Self = "truncatedBlocks"
}

/// Message 1's payload (06 §6.2).
public struct Hello: Codable, Hashable, Sendable {
  public var v: Int
  public var env: String
  /// Handshake counter; 0 when pairing.
  public var n: Int
  public var channel: VersionRange
  public var app: App
  public var caps: [ClientCap]
  public var providers: [String]
  public var presence: Presence?
  public var pair: Pair?

  public init(
    env: String, n: Int, app: App, caps: [ClientCap], providers: [String], presence: Presence? = nil,
    pair: Pair? = nil
  ) {
    v = 1
    self.env = env
    self.n = n
    channel = VersionRange(min: 1, max: 1)
    self.app = app
    self.caps = caps
    self.providers = providers
    self.presence = presence
    self.pair = pair
  }

  public struct VersionRange: Codable, Hashable, Sendable {
    public var min: Int
    public var max: Int

    public init(min: Int, max: Int) {
      self.min = min
      self.max = max
    }
  }

  public struct App: Codable, Hashable, Sendable {
    public var name: String
    public var version: String
    public var build: String
    /// "ios", "android" or "node".
    public var platform: String
    public var os: String
    public var model: String?

    public init(name: String, version: String, build: String, platform: String, os: String, model: String? = nil) {
      self.name = name
      self.version = version
      self.build = build
      self.platform = platform
      self.os = os
      self.model = model
    }
  }

  public struct Pair: Codable, Hashable, Sendable {
    public var offer: String

    public init(offer: String) {
      self.offer = offer
    }
  }
}

public struct HostInfo: Codable, Hashable, Sendable {
  public var name: String
  public var platform: String
  public var version: String
  public var fingerprint: String

  public init(name: String, platform: String, version: String, fingerprint: String) {
    self.name = name
    self.platform = platform
    self.version = version
    self.fingerprint = fingerprint
  }
}

public struct Role: OpenCode {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let admin: Self = "admin"
  public static let member: Self = "member"
}

public struct Relay: Codable, Hashable, Sendable {
  public var url: String
  public var room: String

  public init(url: String, room: String) {
    self.url = url
    self.room = room
  }
}

/// Message 2's payload for a paired device (06 §6.2).
public struct Welcome: Codable, Hashable, Sendable {
  public var ok: Bool
  public var channel: Int
  public var env: String
  public var boot: String
  public var time: Double
  public var host: HostInfo
  public var device: Device
  public var capabilities: [String]
  public var providers: [String]
  public var endpoints: [Endpoint]
  public var relay: Relay?
  public var push: Push
  public var limits: Limits

  public init(
    env: String, boot: String, time: Double, host: HostInfo, device: Device, capabilities: [String],
    providers: [String], endpoints: [Endpoint] = [], relay: Relay? = nil, push: Push = Push(enabled: false),
    limits: Limits = Limits(maxMessage: MonoChannel.maxMessage, maxInFlight: 64, maxWatchedSessions: 8)
  ) {
    ok = true
    channel = 1
    self.env = env
    self.boot = boot
    self.time = time
    self.host = host
    self.device = device
    self.capabilities = capabilities
    self.providers = providers
    self.endpoints = endpoints
    self.relay = relay
    self.push = push
    self.limits = limits
  }

  public struct Device: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var role: Role

    public init(id: String, name: String, role: Role) {
      self.id = id
      self.name = name
      self.role = role
    }
  }

  public struct Push: Codable, Hashable, Sendable {
    public var enabled: Bool

    public init(enabled: Bool) {
      self.enabled = enabled
    }
  }

  public struct Limits: Codable, Hashable, Sendable {
    public var maxMessage: Int
    public var maxInFlight: Int
    public var maxWatchedSessions: Int

    public init(maxMessage: Int, maxInFlight: Int, maxWatchedSessions: Int) {
      self.maxMessage = maxMessage
      self.maxInFlight = maxInFlight
      self.maxWatchedSessions = maxWatchedSessions
    }
  }

  enum CodingKeys: String, CodingKey {
    case ok, channel, env, boot, time, host, device, capabilities, providers, endpoints, relay, push, limits
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    ok = try c.decode(Bool.self, forKey: .ok)
    channel = try c.decode(Int.self, forKey: .channel)
    env = try c.decode(String.self, forKey: .env)
    boot = try c.decode(String.self, forKey: .boot)
    time = try c.decode(Double.self, forKey: .time)
    host = try c.decode(HostInfo.self, forKey: .host)
    device = try c.decode(Device.self, forKey: .device)
    capabilities = try c.decode([String].self, forKey: .capabilities)
    providers = try c.decode([String].self, forKey: .providers)
    endpoints = try c.decode([Endpoint].self, forKey: .endpoints)
    relay = try c.decodeIfPresent(Relay.self, forKey: .relay)
    push = try c.decode(Push.self, forKey: .push)
    limits = try c.decode(Limits.self, forKey: .limits)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(ok, forKey: .ok)
    try c.encode(channel, forKey: .channel)
    try c.encode(env, forKey: .env)
    try c.encode(boot, forKey: .boot)
    try c.encode(JSONValue.number(time), forKey: .time)
    try c.encode(host, forKey: .host)
    try c.encode(device, forKey: .device)
    try c.encode(capabilities, forKey: .capabilities)
    try c.encode(providers, forKey: .providers)
    try c.encode(endpoints, forKey: .endpoints)
    // `relay` is null, not absent, when the host has no relay.
    try c.encode(relay, forKey: .relay)
    try c.encode(push, forKey: .push)
    try c.encode(limits, forKey: .limits)
  }
}

/// Message 2's payload for a pairing principal (06 §6.2).
public struct PairingWelcome: Codable, Hashable, Sendable {
  public var ok: Bool
  public var channel: Int
  public var env: String
  public var boot: String
  public var time: Double
  public var host: HostInfo
  public var pairing: Pairing

  public init(env: String, boot: String, time: Double, host: HostInfo, pairing: Pairing) {
    ok = true
    channel = 1
    self.env = env
    self.boot = boot
    self.time = time
    self.host = host
    self.pairing = pairing
  }

  public struct Pairing: Codable, Hashable, Sendable {
    public var offer: String
    public var expiresAt: Double

    public init(offer: String, expiresAt: Double) {
      self.offer = offer
      self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey { case offer, expiresAt }

    public init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      offer = try c.decode(String.self, forKey: .offer)
      expiresAt = try c.decode(Double.self, forKey: .expiresAt)
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(offer, forKey: .offer)
      try c.encode(JSONValue.number(expiresAt), forKey: .expiresAt)
    }
  }

  enum CodingKeys: String, CodingKey { case ok, channel, env, boot, time, host, pairing }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    ok = try c.decode(Bool.self, forKey: .ok)
    channel = try c.decode(Int.self, forKey: .channel)
    env = try c.decode(String.self, forKey: .env)
    boot = try c.decode(String.self, forKey: .boot)
    time = try c.decode(Double.self, forKey: .time)
    host = try c.decode(HostInfo.self, forKey: .host)
    pairing = try c.decode(Pairing.self, forKey: .pairing)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(ok, forKey: .ok)
    try c.encode(channel, forKey: .channel)
    try c.encode(env, forKey: .env)
    try c.encode(boot, forKey: .boot)
    try c.encode(JSONValue.number(time), forKey: .time)
    try c.encode(host, forKey: .host)
    try c.encode(pairing, forKey: .pairing)
  }
}

/// An error inside message 2. It is authenticated by the host key.
public struct HandshakeError: Codable, Hashable, Sendable {
  public var ok: Bool
  public var code: ChannelErrorCode
  public var message: String

  public init(code: ChannelErrorCode, message: String) {
    ok = false
    self.code = code
    self.message = message
  }
}

/// Message 2's payload: a welcome, a pairing welcome, or an error.
public enum HandshakeReply: Codable, Hashable, Sendable {
  case welcome(Welcome)
  case pairing(PairingWelcome)
  case error(HandshakeError)

  private enum Keys: String, CodingKey { case ok, pairing }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    if try !c.decode(Bool.self, forKey: .ok) {
      self = .error(try HandshakeError(from: decoder))
    } else if c.contains(.pairing) {
      self = .pairing(try PairingWelcome(from: decoder))
    } else {
      self = .welcome(try Welcome(from: decoder))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    switch self {
    case let .welcome(value): try value.encode(to: encoder)
    case let .pairing(value): try value.encode(to: encoder)
    case let .error(value): try value.encode(to: encoder)
    }
  }
}

public struct ByeCode: OpenCode {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  public static let rekey: Self = "rekey"
  public static let replaced: Self = "replaced"
  public static let background: Self = "background"
  public static let deviceRevoked: Self = "device_revoked"
  public static let hostStopping: Self = "host_stopping"
  public static let protocolError: Self = "protocol_error"
  public static let idleTimeout: Self = "idle_timeout"
  public static let pairingClosed: Self = "pairing_closed"
}

/// 06 §6.11.
public struct ChannelErrorCode: OpenCode {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  // Requests
  public static let invalidParams: Self = "invalid_params"
  public static let methodNotFound: Self = "method_not_found"
  public static let notFound: Self = "not_found"
  public static let sessionBusy: Self = "session_busy"
  public static let branchSwitching: Self = "branch_switching"
  public static let staleTurn: Self = "stale_turn"
  public static let alreadyResolved: Self = "already_resolved"
  public static let planNotReady: Self = "plan_not_ready"
  public static let idempotencyConflict: Self = "idempotency_conflict"
  public static let providerUnavailable: Self = "provider_unavailable"
  public static let payloadTooLarge: Self = "payload_too_large"
  public static let hostStopping: Self = "host_stopping"
  public static let transferExpired: Self = "transfer_expired"
  public static let unauthorized: Self = "unauthorized"
  public static let forbidden: Self = "forbidden"
  public static let capabilityMissing: Self = "capability_missing"
  public static let rateLimited: Self = "rate_limited"
  public static let `internal`: Self = "internal"
  // Handshake
  public static let handshakeFailed: Self = "handshake_failed"
  public static let unknownDevice: Self = "unknown_device"
  public static let deviceRevoked: Self = "device_revoked"
  public static let devicePending: Self = "device_pending"
  public static let replayedHandshake: Self = "replayed_handshake"
  public static let hostIdentityChanged: Self = "host_identity_changed"
  public static let protocolIncompatible: Self = "protocol_incompatible"
  // Pairing
  public static let pairingExpired: Self = "pairing_expired"
  public static let pairingUsed: Self = "pairing_used"
  public static let pairingCancelled: Self = "pairing_cancelled"
  public static let pairingProofInvalid: Self = "pairing_proof_invalid"
  public static let deviceKeyInUse: Self = "device_key_in_use"
  // Client-side only
  public static let offline: Self = "offline"
  public static let timeout: Self = "timeout"
}

/// A failed request (06 §6.3). Thrown by `Channel.request`.
public struct ChannelError: Codable, Hashable, Sendable, Error, LocalizedError {
  public var code: ChannelErrorCode
  public var message: String
  public var retryable: Bool
  public var data: JSONValue?

  public init(code: ChannelErrorCode, message: String, retryable: Bool, data: JSONValue? = nil) {
    self.code = code
    self.message = message
    self.retryable = retryable
    self.data = data
  }

  public var errorDescription: String? { message }

  static let offline = ChannelError(code: .offline, message: "Not connected", retryable: true)
  static let connectionLost = ChannelError(code: .offline, message: "Connection lost", retryable: true)
  static let timedOut = ChannelError(code: .timeout, message: "The host did not answer", retryable: true)
}

/// What the phone sends (06 §6.3).
public enum ClientMessage: Codable, Hashable, Sendable {
  case request(id: Int, method: String, params: [String: JSONValue]?, key: String?)
  case cancel(id: Int)
  case ping(ts: Double, presence: Presence?)
  case bye(ByeCode)

  private enum Keys: String, CodingKey { case t, id, m, p, key, ts, presence, code }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try c.decode(String.self, forKey: .t) {
    case "req":
      self = .request(
        id: try c.decode(Int.self, forKey: .id), method: try c.decode(String.self, forKey: .m),
        params: try c.decodeIfPresent([String: JSONValue].self, forKey: .p),
        key: try c.decodeIfPresent(String.self, forKey: .key)
      )
    case "cancel":
      self = .cancel(id: try c.decode(Int.self, forKey: .id))
    case "ping":
      self = .ping(ts: try c.decode(Double.self, forKey: .ts), presence: try c.decodeIfPresent(Presence.self, forKey: .presence))
    case "bye":
      self = .bye(try c.decode(ByeCode.self, forKey: .code))
    case let t:
      throw DecodingError.dataCorruptedError(forKey: .t, in: c, debugDescription: "Unknown client message \(t)")
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case let .request(id, method, params, key):
      try c.encode("req", forKey: .t)
      try c.encode(id, forKey: .id)
      try c.encode(method, forKey: .m)
      try c.encodeIfPresent(params, forKey: .p)
      try c.encodeIfPresent(key, forKey: .key)
    case let .cancel(id):
      try c.encode("cancel", forKey: .t)
      try c.encode(id, forKey: .id)
    case let .ping(ts, presence):
      try c.encode("ping", forKey: .t)
      try c.encode(JSONValue.number(ts), forKey: .ts)
      try c.encodeIfPresent(presence, forKey: .presence)
    case let .bye(code):
      try c.encode("bye", forKey: .t)
      try c.encode(code, forKey: .code)
    }
  }
}

/// What the host sends (06 §6.3). Unknown kinds decode to `unknown`.
public enum HostMessage: Codable, Hashable, Sendable {
  case result(id: Int, JSONValue)
  case error(id: Int, ChannelError)
  case event(name: String, data: JSONValue)
  case pong(ts: Double, now: Double)
  case bye(ByeCode, message: String?)
  case unknown(String)

  private enum Keys: String, CodingKey { case t, id, ok, r, e, d, ts, now, code, message }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try c.decode(String.self, forKey: .t) {
    case "res":
      let id = try c.decode(Int.self, forKey: .id)
      if try c.decode(Bool.self, forKey: .ok) {
        // A result of `undefined` is dropped by JSON.stringify.
        self = .result(id: id, try c.decodeIfPresent(JSONValue.self, forKey: .r) ?? .null)
      } else {
        self = .error(id: id, try c.decode(ChannelError.self, forKey: .e))
      }
    case "evt":
      self = .event(name: try c.decode(String.self, forKey: .e), data: try c.decodeIfPresent(JSONValue.self, forKey: .d) ?? .null)
    case "pong":
      self = .pong(ts: try c.decode(Double.self, forKey: .ts), now: try c.decode(Double.self, forKey: .now))
    case "bye":
      self = .bye(try c.decode(ByeCode.self, forKey: .code), message: try c.decodeIfPresent(String.self, forKey: .message))
    case let t:
      self = .unknown(t)
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case let .result(id, value):
      try c.encode("res", forKey: .t)
      try c.encode(id, forKey: .id)
      try c.encode(true, forKey: .ok)
      try c.encode(value, forKey: .r)
    case let .error(id, error):
      try c.encode("res", forKey: .t)
      try c.encode(id, forKey: .id)
      try c.encode(false, forKey: .ok)
      try c.encode(error, forKey: .e)
    case let .event(name, data):
      try c.encode("evt", forKey: .t)
      try c.encode(name, forKey: .e)
      try c.encode(data, forKey: .d)
    case let .pong(ts, now):
      try c.encode("pong", forKey: .t)
      try c.encode(JSONValue.number(ts), forKey: .ts)
      try c.encode(JSONValue.number(now), forKey: .now)
    case let .bye(code, message):
      try c.encode("bye", forKey: .t)
      try c.encode(code, forKey: .code)
      try c.encodeIfPresent(message, forKey: .message)
    case let .unknown(t):
      try c.encode(t, forKey: .t)
    }
  }
}

/// Message scheduling classes (03 §3.5). Lower values go first.
public enum Priority: Int, Comparable, CaseIterable, Sendable {
  /// `pong`, `bye`, requests, small responses, `attention` and `pair.*` events.
  case urgent = 0
  /// Other responses and events.
  case normal = 1
  /// Snapshots, block pages, file and attachment reads.
  case bulk = 2

  public static func < (a: Priority, b: Priority) -> Bool { a.rawValue < b.rawValue }
}

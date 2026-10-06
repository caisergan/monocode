import Foundation
import MonoWire

/// A paired host, as the phone remembers it (12 §12.6). Stored as JSON in
/// `hosts`. No secrets: the device key and handshake counter live in the
/// Keychain.
public struct HostRecord: Codable, Hashable, Sendable, Identifiable {
  public var env: String
  public var label: String
  public var color: String
  public var hostName: String
  public var platform: String
  public var fingerprint: String
  /// The host's static public key, pinned at pairing (base64url).
  public var hostKey: String
  public var deviceId: String
  public var role: Role
  public var endpoints: [HostEndpoint]
  public var relay: RelayInfo?
  /// Push is enabled on the host; the gateway comes from the publisher config.
  public var pushEnabled: Bool
  public var pairedAt: Date
  public var lastOnlineAt: Date?
  public var lastWelcome: WelcomeSummary?
  public var notifications: NotificationPrefs

  public var id: String { env }

  public init(
    env: String, label: String, color: String, hostName: String, platform: String, fingerprint: String,
    hostKey: String, deviceId: String, role: Role, endpoints: [HostEndpoint], relay: RelayInfo? = nil,
    pushEnabled: Bool = false, pairedAt: Date, lastOnlineAt: Date? = nil, lastWelcome: WelcomeSummary? = nil,
    notifications: NotificationPrefs = NotificationPrefs()
  ) {
    self.env = env
    self.label = label
    self.color = color
    self.hostName = hostName
    self.platform = platform
    self.fingerprint = fingerprint
    self.hostKey = hostKey
    self.deviceId = deviceId
    self.role = role
    self.endpoints = endpoints
    self.relay = relay
    self.pushEnabled = pushEnabled
    self.pairedAt = pairedAt
    self.lastOnlineAt = lastOnlineAt
    self.lastWelcome = lastWelcome
    self.notifications = notifications
  }

  public enum Role: String, Codable, Hashable, Sendable {
    case admin, member
  }

  public struct RelayInfo: Codable, Hashable, Sendable {
    public var url: String
    public var room: String

    public init(url: String, room: String) {
      self.url = url
      self.room = room
    }
  }

  /// What the last welcome said about the host.
  public struct WelcomeSummary: Codable, Hashable, Sendable {
    public var host: Welcome.Host
    public var capabilities: [String]
    public var providers: [String]
    public var limits: Welcome.Limits?

    public init(host: Welcome.Host, capabilities: [String], providers: [String], limits: Welcome.Limits? = nil) {
      self.host = host
      self.capabilities = capabilities
      self.providers = providers
      self.limits = limits
    }

    public init(_ welcome: Welcome) {
      self.init(host: welcome.host, capabilities: welcome.capabilities, providers: welcome.providers, limits: welcome.limits)
    }
  }
}

/// A direct address for a host (06 §6.2, 05 §5.2).
public struct HostEndpoint: Codable, Hashable, Sendable {
  public var kind: Kind
  public var addr: String
  public var port: Int
  /// A Tailscale MagicDNS name, tried after the IP.
  public var dns: String?

  public init(kind: Kind, addr: String, port: Int, dns: String? = nil) {
    self.kind = kind
    self.addr = addr
    self.port = port
    self.dns = dns
  }

  public enum Kind: String, Codable, Hashable, Sendable {
    case lan, tailscale, manual
  }

  /// The candidate key `kind|addr|port` (05 §5.2).
  public var candidateKey: String { "\(kind.rawValue)|\(addr)|\(port)" }
}

/// Per-host notification preferences (06 `PushRegistration`, 08 §8.11).
public struct NotificationPrefs: Codable, Hashable, Sendable {
  public var enabled: Bool
  public var categories: Categories
  public var preview: Preview
  public var mutedProjects: [String]
  public var mutedSessions: [String]

  public init(
    enabled: Bool = true, categories: Categories = Categories(), preview: Preview = .full,
    mutedProjects: [String] = [], mutedSessions: [String] = []
  ) {
    self.enabled = enabled
    self.categories = categories
    self.preview = preview
    self.mutedProjects = mutedProjects
    self.mutedSessions = mutedSessions
  }

  public struct Categories: Codable, Hashable, Sendable {
    public var approval: Bool
    public var question: Bool
    public var finished: Bool
    public var failed: Bool
    public var usageLimit: Bool

    public init(approval: Bool = true, question: Bool = true, finished: Bool = true, failed: Bool = true, usageLimit: Bool = true) {
      self.approval = approval
      self.question = question
      self.finished = finished
      self.failed = failed
      self.usageLimit = usageLimit
    }
  }

  public enum Preview: String, Codable, Hashable, Sendable {
    case full, minimal
  }
}

/// What the phone remembers about one endpoint candidate (05 §5.2), keyed by
/// `HostEndpoint.candidateKey`.
public struct CandidateStats: Codable, Hashable, Sendable {
  public var lastSuccessAt: Date?
  public var lastFailureAt: Date?
  public var consecutiveFailures: Int
  /// An exponentially weighted moving average.
  public var rttMs: Double?

  public init(lastSuccessAt: Date? = nil, lastFailureAt: Date? = nil, consecutiveFailures: Int = 0, rttMs: Double? = nil) {
    self.lastSuccessAt = lastSuccessAt
    self.lastFailureAt = lastFailureAt
    self.consecutiveFailures = consecutiveFailures
    self.rttMs = rttMs
  }
}

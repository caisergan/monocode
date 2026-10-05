import Foundation

/// A host connection's state (12 §12.4).
public enum HostConnState: Sendable, Equatable {
  case idle
  case connecting
  case online(transport: TransportKind, endpoint: String, rttMs: Int, since: Date)
  case reconnecting(since: Date)
  case offline(reason: OfflineReason, retryAt: Date, lastOnlineAt: Date?)
  case blocked(BlockReason)

  public enum OfflineReason: String, Sendable {
    case noNetwork, hostUnreachable, timeout
  }

  public enum BlockReason: String, Sendable {
    case deviceRevoked, unknownDevice, hostIdentityChanged, protocolIncompatible, appTooOld
  }

  public var isOnline: Bool {
    if case .online = self { return true }
    return false
  }

  /// The status dot of a machine row (11 §11.13).
  public var dot: Dot {
    switch self {
    case .online: .online
    case .connecting, .reconnecting: .connecting
    default: .offline
    }
  }

  public enum Dot: Sendable {
    case online, connecting, offline
  }
}

public enum HostStatus {
  /// "last seen 12 min ago" (11 §11.23).
  public static func lastSeen(_ at: Date, now: Date = Date()) -> String {
    let minutes = Int(now.timeIntervalSince(at) / 60)
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes) min ago" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours) h ago" }
    let days = hours / 24
    return days == 1 ? "yesterday" : "\(days) days ago"
  }

  /// The notice for a machine that can't serve requests, or nil
  /// (src/hosts/status.ts).
  public static func notice(label: String, state: HostConnState?, lastOnlineAt: Date?, now: Date = Date()) -> String? {
    switch state {
    case let .blocked(reason)?:
      switch reason {
      case .deviceRevoked, .unknownDevice: return "This phone was removed from \(label)."
      case .hostIdentityChanged: return "Can’t verify \(label). It was reinstalled or its identity changed."
      default:
        return "\(label) needs a host update. Update it from MonoCode on your computer: Settings → Connections → Update Host."
      }
    case let .offline(_, _, seen)?:
      if let seen = seen ?? lastOnlineAt { return "\(label) is offline · last seen \(lastSeen(seen, now: now))." }
      return "\(label) is offline."
    default:
      return nil
    }
  }
}

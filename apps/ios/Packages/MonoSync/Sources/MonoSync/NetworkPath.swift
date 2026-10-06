import Foundation
import Network

/// The parts of the phone's network path the runtime acts on (05 §5.5,
/// §5.10), so tests can describe one without `NWPathMonitor`.
public struct NetworkPath: Hashable, Sendable {
  public enum Interface: Hashable, Sendable {
    case wifi, wired, cellular, other
  }

  public var satisfied: Bool
  public var interfaces: Set<Interface>
  /// A VPN is up (Tailscale's `utun`): LAN candidates stay eligible on cellular.
  public var vpn: Bool
  /// Low Data Mode.
  public var constrained: Bool

  public init(satisfied: Bool, interfaces: Set<Interface>, vpn: Bool = false, constrained: Bool = false) {
    self.satisfied = satisfied
    self.interfaces = interfaces
    self.vpn = vpn
    self.constrained = constrained
  }

  /// Assumed until the monitor reports: Wi-Fi, so every candidate is tried.
  public static let unknown = NetworkPath(satisfied: true, interfaces: [.wifi])
  public static let none = NetworkPath(satisfied: false, interfaces: [])

  /// Cellular without Wi-Fi or a wire.
  public var onCellularOnly: Bool {
    interfaces.contains(.cellular) && !interfaces.contains(.wifi) && !interfaces.contains(.wired)
  }

  public init(_ path: NWPath) {
    satisfied = path.status == .satisfied
    var interfaces: Set<Interface> = []
    if path.usesInterfaceType(.wifi) { interfaces.insert(.wifi) }
    if path.usesInterfaceType(.wiredEthernet) { interfaces.insert(.wired) }
    if path.usesInterfaceType(.cellular) { interfaces.insert(.cellular) }
    if path.usesInterfaceType(.other) { interfaces.insert(.other) }
    self.interfaces = interfaces
    vpn = path.availableInterfaces.contains { interface in
      interface.type == .other && ["utun", "ipsec", "ppp", "tun"].contains { interface.name.hasPrefix($0) }
    }
    constrained = path.isConstrained
  }
}

/// `NWPathMonitor` feeding a handler on the main actor (05 §5.10).
@MainActor
public final class PathMonitor {
  private let monitor = NWPathMonitor()
  public private(set) var current = NetworkPath.unknown

  public init() {}

  public func start(_ onChange: @escaping @MainActor (NetworkPath) -> Void) {
    monitor.pathUpdateHandler = { path in
      let next = NetworkPath(path)
      Task { @MainActor [weak self] in
        guard let self, next != self.current else { return }
        self.current = next
        onChange(next)
      }
    }
    monitor.start(queue: DispatchQueue(label: "dev.monocode.path"))
  }

  public func stop() {
    monitor.cancel()
  }
}

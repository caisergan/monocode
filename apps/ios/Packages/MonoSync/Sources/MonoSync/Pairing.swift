import Foundation
import MonoChannel
import MonoKeychain
import MonoStore
import Observation

// The phone's pairing steps (04 §4.7), ported from the Expo app's pair.ts:
// validate the offer, make a device key for this host, persist the intent,
// race the offer's candidates with the offer in the hello, prove the secret
// in `pair.claim`, show the confirmation code while the person at the
// computer allows it, then keep the device key in the Keychain and the host
// in the registry.

/// An offer as the review screen shows it.
public struct PairingOffer: Hashable, Sendable {
  public let env: String
  public let host: String
  public let fingerprint: String
  /// "Local network · Tailscale · Relay".
  public let reachable: String
  /// Shown as a warning; the phone still tries, the host clock decides.
  public let expired: Bool
  let offer: Offer

  init(_ offer: Offer, now: Date = Date()) {
    self.offer = offer
    env = offer.env
    host = offer.name
    fingerprint = hostFingerprint(offer.hostKey)
    let kinds = Set((offer.direct ?? []).map(\.kind))
    reachable = [
      kinds.contains(.lan) ? "Local network" : nil,
      kinds.contains(.tailscale) ? "Tailscale" : nil,
      kinds.contains(.manual) ? "Configured address" : nil,
      offer.relay != nil ? "Relay" : nil,
    ].compactMap { $0 }.joined(separator: " · ")
    expired = offer.isExpired(now: now)
  }
}

public enum PairingStage: Equatable, Sendable {
  /// How to pair: scan, or paste a link.
  case start
  case scan
  case review(PairingOffer)
  case connecting(PairingOffer)
  case confirm(PairingOffer, code: String, deadline: Date)
  case paired(PairingOffer, env: String)
  case failed(PairingOffer?, message: String)

  /// Each stage's title (16 §16.6.9).
  public var title: String {
    switch self {
    case .start: "Pair a computer"
    case .scan: "Scan code"
    case let .review(offer): "Connect to \(offer.host)?"
    case .connecting: "Connecting…"
    case .confirm: "Confirm"
    case .paired: "Paired"
    case .failed: "Pair a computer"
    }
  }
}

/// A failure in the phone's words (04 §4.9).
public struct PairingError: Error, Equatable, Sendable, LocalizedError {
  public let message: String
  public var errorDescription: String? { message }

  init(_ message: String) {
    self.message = message
  }

  static func explain(_ error: any Error, host: String) -> PairingError {
    if let error = error as? PairingError { return error }
    let code: ChannelErrorCode? =
      switch error {
      case let failure as HandshakeFailure: failure.code
      case let failure as MonoChannel.ChannelError: failure.code
      case let failure as WireError: ChannelErrorCode(rawValue: failure.code)
      default: nil
      }
    switch code {
    case .handshakeFailed?: return PairingError("This code doesn’t match \(host). Generate a new code and scan again.")
    case .pairingExpired?: return PairingError("This code expired. Generate a new one on \(host).")
    case .pairingUsed?: return PairingError("This code was already used. Generate a new one.")
    case .pairingCancelled?: return PairingError("This code was cancelled. Generate a new one.")
    case .pairingProofInvalid?: return PairingError("Pairing failed. Generate a new code and try again.")
    case .protocolIncompatible?:
      return PairingError(
        "\(host) runs an older MonoCode host. Update it from the desktop (Settings → Connections → Update Host) or with the host installer.")
    case .deviceKeyInUse?: return PairingError("This phone is already paired with \(host).")
    default:
      return PairingError(
        "Can’t reach \(host). Check that your phone is on the same network or Tailscale, or turn on the relay on \(host).")
    }
  }
}

/// The intent written before connecting (04 §4.7 step 4), so a pairing
/// approved while the app was away can finish at the next launch.
struct PendingPairing: Codable, Sendable {
  var env: String
  var key: String
  var offer: String
  var name: String
  /// The device's X25519 secret, base64url.
  var deviceKey: String
  var candidates: [Endpoint]
  var startedAt: Date

  static let maxAge: TimeInterval = 15 * 60
}

/// `pair.claim`'s answer (06 §6.5).
private struct ClaimResult: Decodable {
  let status: String
  let code: String
  let deviceId: String
  let welcome: Welcome?
}

private struct ClaimParams: Encodable, Sendable {
  let offer: String
  let proof: String
  let name: String
  let platform: String
  let model: String?
  let os: String
  let appVersion: String
  let replacesDeviceId: String?
}

/// `pair.status` (06 §6.6).
private struct PairStatus: Decodable {
  let status: String
  let welcome: Welcome?
}

enum Pairer {
  /// How long the person at the computer has (04 §4.7 step 6).
  static let decisionTime: TimeInterval = 120

  /// Runs the pairing up to an approved host record. `onConfirm` shows the
  /// code while the host waits for a decision. Cancelling the task closes
  /// the channel; the host expires the claim.
  static func pair(
    _ offer: Offer, phoneName: String, info: ClientInfo, keychain: Keychain, path: NetworkPath, replaces: String? = nil,
    timings: RaceTimings = RaceTimings(), onConfirm: @escaping @Sendable (String, Date) async -> Void
  ) async throws -> (record: HostRecord, deviceKey: KeyPair) {
    let deviceKey = KeyPair.generate()
    try? keychain.setValue(
      PendingPairing(
        env: offer.env, key: offer.key, offer: offer.offer, name: offer.name, deviceKey: deviceKey.secretKey.base64URL,
        candidates: offer.direct ?? [], startedAt: Date()),
      for: .pendingPairing)
    var keep = false
    defer { if !keep { try? keychain.delete(.pendingPairing) } }
    let env = offer.env
    let pairOffer = offer.offer
    let winner: RaceWinner
    do {
      winner = try await Race.run(
        Candidates.order(offer.direct ?? [], path: path), env: env, hostKey: offer.hostKey, deviceKey: deviceKey,
        timings: timings, hello: { hello(env: env, n: 0, info: info, pairOffer: pairOffer) })
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw PairingError.explain(error, host: offer.name)
    }
    let channel = winner.channel
    do {
      guard case .pairing = winner.welcome else { throw PairingError("This phone is already paired with \(offer.name).") }
      // Listen before claiming: `pair.status` may follow the answer at once.
      let status = Task { () -> PairStatus? in
        for await event in channel.events {
          switch event {
          case let .event("pair.status", frame): return try? ChannelEvent.payload(PairStatus.self, from: frame)
          case .closed: return nil
          default: continue
          }
        }
        return nil
      }
      defer { status.cancel() }
      let hash = await channel.handshakeHash
      let claim: ClaimResult = try await withTaskCancellationHandler {
        try await channel.request(
          "pair.claim",
          ClaimParams(
            offer: offer.offer, proof: pairingProof(secret: offer.pairingSecret, handshakeHash: hash).base64URL,
            name: phoneName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "iPhone" : phoneName, platform: "ios",
            model: info.model, os: info.os, appVersion: info.version, replacesDeviceId: replaces),
          timeout: .seconds(30))
      } onCancel: {
        Task { await channel.close() }
      }
      // Both screens derive the code from this channel's handshake hash.
      let code = confirmationCode(handshakeHash: hash)
      guard claim.code == code else { throw PairingError("The confirmation codes don’t match. Don’t approve this phone.") }
      var welcome = claim.welcome
      if welcome == nil {
        keep = true
        let deadline = Date().addingTimeInterval(decisionTime)
        await onConfirm(code, deadline)
        let decided = try await withTaskCancellationHandler {
          try await withThrowingTaskGroup(of: PairStatus?.self) { group in
            group.addTask { await status.value }
            group.addTask {
              try await Task.sleep(for: .seconds(decisionTime))
              return PairStatus(status: "expired", welcome: nil)
            }
            defer { group.cancelAll() }
            return try await group.next() ?? nil
          }
        } onCancel: {
          Task { await channel.close() }
        }
        keep = false
        switch decided?.status {
        case "approved"?: welcome = decided?.welcome
        case "denied"?: throw PairingError("\(offer.name) didn’t allow this phone.")
        case "expired"?: throw PairingError("Nobody approved the connection in time.")
        case "cancelled"?: throw PairingError("Pairing was cancelled on the computer.")
        default:
          try Task.checkCancellation()
          throw PairingError("The connection closed before pairing finished.")
        }
      }
      guard let welcome else { throw PairingError("The connection closed before pairing finished.") }
      try keychain.setDeviceKey(deviceKey.secretKey, env: env)
      let record = HostRecord(paired: offer, welcome: welcome)
      // The runtime opens its own device channel; close this one cleanly.
      await channel.sayBye(.replaced)
      return (record, deviceKey)
    } catch {
      await channel.close()
      if error is CancellationError { throw error }
      throw PairingError.explain(error, host: offer.name)
    }
  }

  /// A pairing that was waiting when the app went away (04 §4.7): connects
  /// with its device key and no offer. A welcome means it was approved.
  static func resume(
    keychain: Keychain, info: ClientInfo, path: NetworkPath, now: Date = Date(), timings: RaceTimings = RaceTimings()
  ) async -> ResumeOutcome {
    guard let pending = try? keychain.value(PendingPairing.self, for: .pendingPairing) else { return .nothing }
    guard now.timeIntervalSince(pending.startedAt) < PendingPairing.maxAge,
      let secret = try? Data(base64URL: pending.deviceKey), let deviceKey = try? KeyPair(secretKey: secret),
      let hostKey = try? Data(base64URL: pending.key)
    else {
      try? keychain.delete(.pendingPairing)
      return .nothing
    }
    let env = pending.env
    do {
      let winner = try await Race.run(
        Candidates.order(pending.candidates, path: path), env: env, hostKey: hostKey, deviceKey: deviceKey,
        timings: timings, hello: { hello(env: env, n: Int(try keychain.nextCounter(env: env)), info: info) })
      guard case let .device(welcome) = winner.welcome else {
        await winner.channel.close()
        return .waiting
      }
      await winner.channel.sayBye(.replaced)
      try keychain.setDeviceKey(secret, env: env)
      try? keychain.delete(.pendingPairing)
      var record = HostRecord(paired: pending, welcome: welcome)
      record.label = pending.name
      return .paired(record)
    } catch let failure as HandshakeFailure where failure.authenticated {
      if failure.code == .devicePending { return .waiting }
      try? keychain.delete(.pendingPairing)
      return .denied("\(pending.name) didn’t approve this phone. Scan a new code to try again.")
    } catch {
      return .waiting
    }
  }

  enum ResumeOutcome: Sendable {
    case nothing, waiting
    case paired(HostRecord)
    case denied(String)
  }
}

extension HostRecord {
  /// The registry's record for a host that just approved this phone.
  init(paired offer: Offer, welcome: Welcome, now: Date = Date()) {
    self.init(
      env: offer.env, label: offer.name, color: String(HostRecord.colorIndex(for: offer.env)), hostName: welcome.host.name,
      platform: welcome.host.platform, fingerprint: welcome.host.fingerprint, hostKey: offer.key, deviceId: welcome.device.id,
      role: Role(rawValue: welcome.device.role.rawValue) ?? .member,
      endpoints: (welcome.endpoints.isEmpty ? offer.direct ?? [] : welcome.endpoints).compactMap(HostEndpoint.init),
      relay: (welcome.relay ?? offer.relay).map { RelayInfo(url: $0.url, room: $0.room) }, pushEnabled: welcome.push.enabled,
      pairedAt: now, lastOnlineAt: now, lastWelcome: WelcomeSummary(welcome.wire))
  }

  fileprivate init(paired pending: PendingPairing, welcome: Welcome, now: Date = Date()) {
    self.init(
      env: pending.env, label: pending.name, color: String(HostRecord.colorIndex(for: pending.env)), hostName: welcome.host.name,
      platform: welcome.host.platform, fingerprint: welcome.host.fingerprint, hostKey: pending.key, deviceId: welcome.device.id,
      role: Role(rawValue: welcome.device.role.rawValue) ?? .member,
      endpoints: (welcome.endpoints.isEmpty ? pending.candidates : welcome.endpoints).compactMap(HostEndpoint.init),
      relay: welcome.relay.map { RelayInfo(url: $0.url, room: $0.room) }, pushEnabled: welcome.push.enabled, pairedAt: now,
      lastOnlineAt: now, lastWelcome: WelcomeSummary(welcome.wire))
  }
}

/// The pairing sheet's model (16 §16.6.9): the stage machine, driven by the
/// screens. One per presented sheet.
@MainActor @Observable
public final class PairingFlow: Identifiable {
  public private(set) var stage: PairingStage = .start
  /// A link that didn't parse, shown on the start stage.
  public private(set) var linkError: String?
  public var phoneName: String

  @ObservationIgnored private unowned let engine: SyncEngine
  @ObservationIgnored private var task: Task<Void, Never>?

  public init(engine: SyncEngine, phoneName: String) {
    self.engine = engine
    self.phoneName = phoneName
  }

  /// A pasted, scanned or opened link. False (with `linkError` set) when it
  /// isn't a MonoCode pairing link.
  @discardableResult
  public func read(_ text: String) -> Bool {
    do {
      #if DEBUG
        let offer = try parseOfferLink(text, allowInsecureRelay: true)
      #else
        let offer = try parseOfferLink(text)
      #endif
      // Rule 6 (04 §4.2): a host already paired and working is not paired twice.
      if let record = engine.hosts.record(offer.env), !record.isDemo, !isBlocked(offer.env) {
        linkError = "This phone is already paired with \(record.label)."
        stage = .start
        return false
      }
      linkError = nil
      stage = .review(PairingOffer(offer))
      return true
    } catch {
      linkError = error.message
      if case .scan = stage { stage = .start }
      return false
    }
  }

  private func isBlocked(_ env: String) -> Bool {
    if case .blocked? = engine.hosts.states[env] { return true }
    return false
  }

  public func showScanner() {
    linkError = nil
    stage = .scan
  }

  public func backToStart() {
    task?.cancel()
    task = nil
    stage = .start
  }

  /// Connect: race, claim, confirm, save (04 §4.7 steps 4 to 7).
  public func connect() {
    guard case let .review(offer) = stage else { return }
    stage = .connecting(offer)
    let engine = engine
    let replaces = engine.hosts.record(offer.env)?.deviceId
    let (name, info, keychain, timings) = (phoneName, engine.info, engine.persistence.keychain, engine.timings)
    let path = engine.currentPath
    task = Task {
      do {
        let (record, _) = try await Pairer.pair(
          offer.offer, phoneName: name, info: info, keychain: keychain, path: path, replaces: replaces, timings: timings
        ) { code, deadline in
          await MainActor.run { [weak self] in
            guard let self, case .connecting = self.stage else { return }
            self.stage = .confirm(offer, code: code, deadline: deadline)
          }
        }
        guard !Task.isCancelled else { return }
        engine.addPaired(record)
        stage = .paired(offer, env: record.env)
      } catch is CancellationError {
        return
      } catch {
        guard !Task.isCancelled else { return }
        stage = .failed(offer, message: (error as? PairingError)?.message ?? error.localizedDescription)
      }
    }
  }

  /// Back to the review, to try the same offer again.
  public func retry() {
    if case let .failed(offer?, _) = stage { stage = .review(offer) } else { stage = .start }
  }

  /// Cancel closes the channel; the host expires the claim.
  public func cancel() {
    task?.cancel()
    task = nil
  }
}

extension SyncEngine {
  var currentPath: NetworkPath { pathSnapshot }

  /// Finishes or discards a pairing left waiting when the app went away.
  public func resumePendingPairing() async {
    switch await Pairer.resume(keychain: persistence.keychain, info: info, path: pathSnapshot, timings: timings) {
    case let .paired(record):
      addPaired(record)
    case let .denied(message):
      pairingNotice = message
    case .nothing, .waiting:
      break
    }
  }
}

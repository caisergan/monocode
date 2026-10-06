import XCTest

/// The R2 run against a real host (16 §16.7): pairing through a pasted link
/// and through a deep link the system opens, the projects list, a host
/// restart and a revoke, and S23's addresses one by one. A control server
/// next to the host, `scripts/host-control.mjs` (`MC_HOST_CONTROL`, passed as
/// `TEST_RUNNER_MC_HOST_CONTROL`), starts the host in a temporary data
/// directory, hands out pairing links, approves claims, restarts the host and
/// revokes the phone; its header has the commands. Screenshots go to
/// `MC_SHOTS_DIR` when it is set. Skipped without a host, so check.sh does
/// not run it.
final class PairingUITests: XCTestCase {
  var control: URL!
  var folder: URL?
  var theme = "dark"

  override func setUpWithError() throws {
    continueAfterFailure = false
    let environment = ProcessInfo.processInfo.environment
    guard let control = environment["MC_HOST_CONTROL"].flatMap(URL.init(string:)) else {
      throw XCTSkip("MC_HOST_CONTROL is not set")
    }
    self.control = control
    if let path = environment["MC_SHOTS_DIR"] {
      folder = URL(fileURLWithPath: path)
      try FileManager.default.createDirectory(at: folder!, withIntermediateDirectories: true)
    }
  }

  @MainActor func testPastedLinkDark() throws { try pastedLink("dark") }
  @MainActor func testPastedLinkLight() throws { try pastedLink("light") }
  @MainActor func testDeepLinkDark() throws { try deepLink("dark") }
  @MainActor func testDeepLinkLight() throws { try deepLink("light") }
  @MainActor func testConnectingDark() throws { try connecting("dark") }
  @MainActor func testConnectingLight() throws { try connecting("light") }
  @MainActor func testDeniedDark() throws { try denied("dark") }
  @MainActor func testDeniedLight() throws { try denied("light") }

  /// Paste link, over 127.0.0.1 only: every stage, the projects, Settings →
  /// Machines, a host restart, then a revoke.
  @MainActor
  private func pastedLink(_ theme: String) throws {
    self.theme = theme
    let link = try fetch("link?only=manual&approveAfter=4000")["url"] as! String
    let app = launch()
    app.buttons["Pair with a computer"].tap()
    XCTAssertTrue(app.navigationBars["Pair a computer"].waitForExistence(timeout: 10))
    try shot("01-pair-start")

    UIPasteboard.general.string = link
    let paste = app.buttons["Paste"].firstMatch
    XCTAssertTrue(paste.waitForExistence(timeout: 5))
    paste.tap()
    let review = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH 'Connect to'")).firstMatch
    XCTAssertTrue(review.waitForExistence(timeout: 10), "the pasted link did not open the review")
    try shot("03-pair-review")

    app.buttons["Connect"].tap()
    XCTAssertTrue(find(app, "identifier == 'pairing.code'").waitForExistence(timeout: 25), "no confirmation code")
    try shot("06-pair-confirm")
    XCTAssertTrue(app.navigationBars["Paired"].waitForExistence(timeout: 20), "the host's approval did not arrive")
    sleep(1)
    try shot("07-pair-paired")
    app.buttons["Continue"].tap()

    // The host's projects, over the Noise channel.
    app.tabBars.buttons["Projects"].tap()
    XCTAssertTrue(find(app, "label CONTAINS 'my-app'").waitForExistence(timeout: 20), "the projects did not load")
    XCTAssertTrue(find(app, "label CONTAINS 'api-server'").exists)
    try shot("09-projects")

    app.tabBars.buttons["Settings"].tap()
    openMachines(app)
    XCTAssertTrue(find(app, "label == 'Your machines'").waitForExistence(timeout: 10))
    XCTAssertTrue(find(app, "identifier == 'machine.row' AND label CONTAINS 'Connected'").waitForExistence(timeout: 10))
    try shot("10-machines")
    app.buttons.matching(NSPredicate(format: "identifier == 'machine.row' OR label CONTAINS 'Connected'")).firstMatch.tap()
    XCTAssertTrue(find(app, "label CONTAINS 'Fingerprint'").waitForExistence(timeout: 10))
    try shot("11-machine-details")

    // A host restart: the status leaves Connected, then comes back by itself.
    _ = try fetch("restart?downMs=4000")
    XCTAssertTrue(
      find(app, "label CONTAINS 'Offline' OR label CONTAINS 'Checking connection…'").waitForExistence(timeout: 20),
      "the drop was not seen")
    try shot("12-machine-reconnecting")
    XCTAssertTrue(find(app, "label CONTAINS 'Connected'").waitForExistence(timeout: 60), "no reconnect after the restart")

    // Relaunched while paired: the host comes back from the cache and
    // connects with the device key from the system Keychain.
    app.terminate()
    app.launchArguments = ["-MCTheme", theme]
    app.launch()
    app.tabBars.buttons["Settings"].tap()
    openMachines(app)
    XCTAssertTrue(
      find(app, "identifier == 'machine.row' AND label CONTAINS 'Connected'").waitForExistence(timeout: 30),
      "no connection after a relaunch")
    app.buttons.matching(NSPredicate(format: "identifier == 'machine.row' OR label CONTAINS 'Connected'")).firstMatch.tap()
    XCTAssertTrue(find(app, "label CONTAINS 'Fingerprint'").waitForExistence(timeout: 10))

    // A revoke: the blocked state, here and on Agents.
    _ = try fetch("revoke")
    XCTAssertTrue(find(app, "identifier == 'machine.blocked'").waitForExistence(timeout: 20), "the revoke was not shown")
    sleep(1)
    try shot("13-machine-revoked")
    app.tabBars.buttons["Agents"].tap()
    let removed = find(app, "label BEGINSWITH 'This phone was removed from'")
    XCTAssertTrue(removed.waitForExistence(timeout: 10))
    try shot("14-agents-revoked")

    // Relaunched, the paired host comes back from the cache, still blocked.
    app.terminate()
    let again = launch(reset: false)
    XCTAssertTrue(
      find(again, "label BEGINSWITH 'This phone was removed from'").waitForExistence(timeout: 30))
  }

  /// A deep link the system opens (`monocode-dev://pair#o=…`), over the
  /// Mac's LAN address only. The review proves the fragment arrived.
  @MainActor
  private func deepLink(_ theme: String) throws {
    self.theme = theme
    let link = try fetch("link?only=lan")["url"] as! String
    let app = launch()
    XCTAssertTrue(app.buttons["Pair with a computer"].waitForExistence(timeout: 20))
    XCUIDevice.shared.system.open(URL(string: link)!)
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let open = springboard.buttons["Open"]
    if open.waitForExistence(timeout: 5) { open.tap() }
    let review = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH 'Connect to'")).firstMatch
    XCTAssertTrue(review.waitForExistence(timeout: 15), "the deep link's offer (in the fragment) did not reach the app")
    XCTAssertTrue(find(app, "label CONTAINS 'Local network'").exists)
    app.buttons["Connect"].tap()
    // A LAN offer explains the local network prompt first (04 §4.7 step 3).
    XCTAssertTrue(find(app, "identifier == 'pairing.localNetwork'").waitForExistence(timeout: 5), "no local network explainer")
    try shot("04-pair-local-network")
    app.buttons["Continue"].tap()
    XCTAssertTrue(app.navigationBars["Paired"].waitForExistence(timeout: 30), "pairing over the LAN address failed")
    app.buttons["Continue"].tap()
    app.tabBars.buttons["Projects"].tap()
    XCTAssertTrue(find(app, "label CONTAINS 'my-app'").waitForExistence(timeout: 20))
    app.tabBars.buttons["Settings"].tap()
    openMachines(app)
    XCTAssertTrue(find(app, "label CONTAINS 'Direct · Wi-Fi'").waitForExistence(timeout: 10))
    _ = try fetch("revoke")
  }

  /// Connecting, held open by an address that never answers; then Cancel.
  @MainActor
  private func connecting(_ theme: String) throws {
    self.theme = theme
    let link = try fetch("link?only=blackhole")["url"] as! String
    let app = launch(["-MCOpen", link])
    XCTAssertTrue(app.buttons["Connect"].waitForExistence(timeout: 20))
    app.buttons["Connect"].tap()
    XCTAssertTrue(app.navigationBars["Connecting…"].waitForExistence(timeout: 5))
    try shot("05-pair-connecting")
    app.buttons["Cancel"].tap()
    XCTAssertTrue(app.buttons["Pair with a computer"].waitForExistence(timeout: 10))
  }

  /// S23: pairing over the Tailscale IP alone, then the MagicDNS name alone
  /// (`*.ts.net`, the ATS exception). Each pairs, lists projects, revokes.
  @MainActor func testTailscaleAddresses() throws {
    for only in ["tsip", "tsname"] {
      let link = try fetch("link?only=\(only)")["url"] as! String
      let app = launch(["-MCOpen", link])
      XCTAssertTrue(app.buttons["Connect"].waitForExistence(timeout: 20))
      app.buttons["Connect"].tap()
      XCTAssertTrue(app.navigationBars["Paired"].waitForExistence(timeout: 30), "pairing over \(only) failed")
      app.buttons["Continue"].tap()
      app.tabBars.buttons["Projects"].tap()
      XCTAssertTrue(find(app, "label CONTAINS 'my-app'").waitForExistence(timeout: 20), "no projects after \(only)")
      _ = try fetch("revoke")
      app.terminate()
    }
  }

  /// The computer says no: the failed stage.
  @MainActor
  private func denied(_ theme: String) throws {
    self.theme = theme
    let link = try fetch("link?only=manual&deny=1")["url"] as! String
    let app = launch(["-MCOpen", link])
    XCTAssertTrue(app.buttons["Connect"].waitForExistence(timeout: 20))
    app.buttons["Connect"].tap()
    XCTAssertTrue(find(app, "identifier == 'pairing.error'").waitForExistence(timeout: 30))
    XCTAssertTrue(find(app, "identifier == 'pairing.error'").label.contains("didn’t allow this phone"))
    sleep(1)
    try shot("08-pair-failed")
  }

  override func tearDown() {
    // The tree at a failure, next to the screenshots.
    if let folder, (testRun?.totalFailureCount ?? 0) > 0 {
      let tree = MainActor.assumeIsolated { XCUIApplication().debugDescription }
      try? tree.write(to: folder.appending(path: "failure-\(name).txt"), atomically: true, encoding: .utf8)
    }
    super.tearDown()
  }

  /// Settings → Machines, once the Settings root is up.
  @MainActor
  private func openMachines(_ app: XCUIApplication) {
    let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Machines'")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    sleep(1)
    row.tap()
  }

  /// Any element by predicate: SwiftUI merges a button's texts into one label.
  @MainActor
  private func find(_ app: XCUIApplication, _ format: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: format)).firstMatch
  }

  @MainActor
  private func launch(_ arguments: [String] = [], reset: Bool = true) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-MCTheme", theme] + (reset ? ["-MCReset", "YES"] : []) + arguments
    app.launch()
    return app
  }

  @MainActor
  private func shot(_ name: String) throws {
    guard let folder else { return }
    let png = XCUIScreen.main.screenshot().pngRepresentation
    try png.write(to: folder.appending(path: "\(name)-\(theme).png"))
  }

  /// A request to the control server, waited for.
  private func fetch(_ path: String) throws -> [String: Any] {
    let url = URL(string: path, relativeTo: control)!
    let done = expectation(description: path)
    nonisolated(unsafe) var result: Result<Data, any Error> = .failure(URLError(.unknown))
    URLSession.shared.dataTask(with: url) { data, _, error in
      result = data.map { .success($0) } ?? .failure(error ?? URLError(.badServerResponse))
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 30)
    return try JSONSerialization.jsonObject(with: try result.get()) as? [String: Any] ?? [:]
  }
}

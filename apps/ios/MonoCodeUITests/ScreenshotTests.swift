import XCTest

/// Walks the R1 screens in dark and light and writes a PNG of each into
/// `MC_SHOTS_DIR` (pass it as `TEST_RUNNER_MC_SHOTS_DIR`). Skipped without it,
/// so check.sh does not run it.
final class ScreenshotTests: XCTestCase {
  var folder: URL!
  var theme = "dark"

  override func setUpWithError() throws {
    continueAfterFailure = false
    guard let path = ProcessInfo.processInfo.environment["MC_SHOTS_DIR"] else { throw XCTSkip("MC_SHOTS_DIR is not set") }
    folder = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  @MainActor func testDark() throws { try walk("dark") }
  @MainActor func testLight() throws { try walk("light") }
  @MainActor func testFileChipDark() throws { try fileChip("dark") }
  @MainActor func testFileChipLight() throws { try fileChip("light") }

  @MainActor
  private func fileChip(_ theme: String) throws {
    self.theme = theme
    var app: XCUIApplication
    // A file chip opens the file; Back returns to the chat. The chip's
    // place is fixed on the iPhone 17 (402 × 874 pt) for this settled session.
    app = launch(["-MCDemo", "YES", "-MCOpen", "monocode-dev://session?id=s-auth"])
    XCTAssertTrue(app.navigationBars["Fix flaky auth test"].waitForExistence(timeout: 30))
    sleep(2)
    app.coordinate(withNormalizedOffset: CGVector(dx: 120.0 / 402, dy: 386.0 / 874)).tap()
    XCTAssertTrue(app.staticTexts["session.ts"].waitForExistence(timeout: 10), "the file chip did not open the file")
    sleep(1)
    try shot(app, "21-file-from-chip")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(app.navigationBars["Fix flaky auth test"].waitForExistence(timeout: 10))

  }

  @MainActor
  private func launch(_ arguments: [String]) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-MCTheme", theme] + arguments
    app.launch()
    return app
  }

  @MainActor
  private func shot(_ app: XCUIApplication, _ name: String) throws {
    let png = XCUIScreen.main.screenshot().pngRepresentation
    try png.write(to: folder.appending(path: "\(name)-\(theme).png"))
  }

  @MainActor
  private func walk(_ theme: String) throws {
    self.theme = theme
    var app = launch([])
    XCTAssertTrue(app.buttons["Try the demo"].waitForExistence(timeout: 30))
    try shot(app, "01-welcome")

    app = launch(["-MCDemo", "YES"])
    XCTAssertTrue(app.staticTexts["Need approval"].firstMatch.waitForExistence(timeout: 30))
    sleep(2)
    try shot(app, "02-agents")

    app.staticTexts["Fix flaky auth test"].press(forDuration: 1.2)
    sleep(1)
    try shot(app, "03-agents-context-menu")

    app = launch(["-MCDemo", "YES"])
    XCTAssertTrue(app.staticTexts["Fix flaky auth test"].waitForExistence(timeout: 15))
    // A slow drag, so the leading action stays revealed.
    let start = app.staticTexts["Fix flaky auth test"].coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
    start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 110, dy: 0)), withVelocity: .slow, thenHoldForDuration: 0.3)
    sleep(1)
    try shot(app, "04-agents-swipe")

    app = launch(["-MCDemo", "YES"])
    app.tabBars.buttons["Projects"].tap()
    XCTAssertTrue(app.staticTexts["my-app"].waitForExistence(timeout: 10))
    sleep(1)
    try shot(app, "05-projects")
    app.staticTexts["my-app"].firstMatch.press(forDuration: 1.2)
    sleep(1)
    try shot(app, "06-projects-context-menu")

    app = launch(["-MCDemo", "YES"])
    app.tabBars.buttons["Projects"].tap()
    XCTAssertTrue(app.staticTexts["my-app"].waitForExistence(timeout: 10))
    app.staticTexts["my-app"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["Fix flaky auth test"].waitForExistence(timeout: 10))
    sleep(2)
    try shot(app, "07-project")
    app.buttons["Filter"].tap()
    sleep(1)
    try shot(app, "08-project-filter-menu")
    app.buttons["Archived"].tap()
    sleep(2)
    try shot(app, "09-project-archived")
    app.buttons["Filter"].tap()
    app.buttons["Archived"].tap()
    sleep(1)
    app.swipeUp(velocity: .fast)
    sleep(2)
    try shot(app, "10-project-scrolled-accessory-inline")
    app.swipeDown(velocity: .fast)
    app.swipeDown(velocity: .fast)
    sleep(1)
    app.buttons["Explorer"].tap()
    sleep(1)
    try shot(app, "11-project-explorer")
    app.buttons["New session"].firstMatch.tap()
    sleep(1)
    try shot(app, "12-new-session")

    app = launch(["-MCDemo", "YES"])
    app.tabBars.buttons["Settings"].tap()
    sleep(1)
    try shot(app, "13-settings")

    app = launch(["-MCDemo", "YES", "-MCDemoOffline", "YES"])
    sleep(4)
    try shot(app, "14-agents-offline-notice")

    app = launch(["-MCDemo", "YES", "-MCOpen", "monocode-dev://session?id=s-auth"])
    XCTAssertTrue(app.navigationBars["Fix flaky auth test"].waitForExistence(timeout: 30))
    sleep(2)
    try shot(app, "15-session")
    app.buttons["Session menu"].tap()
    sleep(1)
    try shot(app, "16-session-menu")
    app.buttons["Session info"].tap()
    sleep(1)
    try shot(app, "17-session-info")

    app = launch(["-MCDemo", "YES", "-MCOpen", "monocode-dev://session?id=s-auth&tool=t-log"])
    XCTAssertTrue(app.navigationBars["Fix flaky auth test"].waitForExistence(timeout: 30))
    sleep(3)
    try shot(app, "18-tool-sheet")

    app = launch(["-MCDemo", "YES", "-MCOpen", "monocode-dev://session?id=s-perf"])
    XCTAssertTrue(app.navigationBars["Profile the transcript scroll"].waitForExistence(timeout: 30))
    sleep(6)
    try shot(app, "19-session-streaming")

    app = launch(["-MCDemo", "YES", "-MCOpen", "monocode-dev://session?id=s-api"])
    XCTAssertTrue(app.navigationBars["Add pagination to /sessions"].waitForExistence(timeout: 30))
    sleep(5)
    app.swipeDown(velocity: .fast)
    sleep(2)
    try shot(app, "20-session-jump-waiting-for-approval")
  }
}

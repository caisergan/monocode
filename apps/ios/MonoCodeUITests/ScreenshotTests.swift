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
    XCTAssertTrue(app.buttons["Try the demo"].waitForExistence(timeout: 10))
    try shot(app, "01-welcome")

    app = launch(["-MCDemo", "YES"])
    XCTAssertTrue(app.staticTexts["Need approval"].firstMatch.waitForExistence(timeout: 15))
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
  }
}

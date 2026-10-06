import XCTest

/// The ⋯ menu on a session that is streaming: the toolbar must not rebuild
/// under the open menu, or its items stop taking taps.
final class SessionMenuUITests: XCTestCase {
  @MainActor
  func testMenuWorksWhileTheSessionStreams() {
    let app = XCUIApplication()
    app.launchArguments = ["-MCReset", "YES", "-MCDemo", "YES", "-MCOpen", "monocode-dev://session?id=s-perf"]
    app.launch()
    XCTAssertTrue(app.navigationBars["Profile the transcript scroll"].waitForExistence(timeout: 30))
    sleep(2)
    for round in 0..<3 {
      app.buttons["Session menu"].tap()
      let info = app.buttons["Session info"]
      XCTAssertTrue(info.waitForExistence(timeout: 3), "round \(round): the menu did not open")
      sleep(1)
      info.tap()
      XCTAssertTrue(app.navigationBars["Session info"].waitForExistence(timeout: 3), "round \(round): Session info did not open")
      app.buttons["Close"].tap()
      XCTAssertTrue(app.navigationBars["Profile the transcript scroll"].waitForExistence(timeout: 3))

      app.buttons["Session menu"].tap()
      // The demo has no harness id, so this copies the MonoCode id at once.
      let copy = app.buttons["Copy session ID"]
      XCTAssertTrue(copy.waitForExistence(timeout: 3), "round \(round): the menu did not open")
      sleep(1)
      copy.tap()
      XCTAssertFalse(copy.waitForExistence(timeout: 1.5), "round \(round): the menu stayed open")
    }
  }
}

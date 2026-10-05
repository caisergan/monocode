import XCTest

/// Runs the Lab the way R0 checks it: the 1,000-turn fixture, the stream and
/// the fling benchmark. The numbers themselves are read from latest.json.
final class TranscriptLabUITests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testSettingsListsTheLab() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.tabBars.buttons["Settings"].waitForExistence(timeout: 10))
    app.tabBars.buttons["Settings"].tap()
    XCTAssertTrue(app.buttons["Transcript Lab"].waitForExistence(timeout: 10))
    app.buttons["Transcript Lab"].tap()
    XCTAssertTrue(app.navigationBars["Transcript Lab"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Fling 10 s"].exists)
  }

  @MainActor
  func testLabStreamsAndFinishesTheFling() {
    let app = XCUIApplication()
    app.launchArguments = ["-MCOpen", "monocode-dev://lab?run=huge-stream"]
    app.launch()
    let streaming = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Streaming'")).firstMatch
    XCTAssertTrue(streaming.waitForExistence(timeout: 15), "the stream did not start")
    let result = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'hitch'")).firstMatch
    XCTAssertTrue(result.waitForExistence(timeout: 40), "the fling did not finish")
    XCTAssertTrue(result.label.contains("1,000 turns"))
  }
}

/// The shell: Welcome, then the demo's agents.
final class ShellUITests: XCTestCase {
  @MainActor
  func testTryTheDemoShowsItsAgents() {
    let app = XCUIApplication()
    app.launch()
    let demo = app.buttons["Try the demo"]
    XCTAssertTrue(demo.waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["Pair with a computer"].isEnabled)
    demo.tap()
    XCTAssertTrue(app.staticTexts["Fix flaky auth test"].waitForExistence(timeout: 10))
    app.tabBars.buttons["Projects"].tap()
    XCTAssertTrue(app.staticTexts["my-app"].waitForExistence(timeout: 10))
  }
}

import XCTest

/// Search on the project screen and the Projects tab: once closed it stays
/// closed, while the demo's live turns keep the lists updating.
final class ProjectSearchUITests: XCTestCase {
  @MainActor
  func testProjectSearchCloses() {
    let app = XCUIApplication()
    app.launchArguments = ["-MCReset", "YES", "-MCDemo", "YES"]
    app.launch()
    XCTAssertTrue(app.tabBars.buttons["Projects"].waitForExistence(timeout: 30))
    app.tabBars.buttons["Projects"].tap()
    XCTAssertTrue(app.staticTexts["my-app"].waitForExistence(timeout: 10))
    app.staticTexts["my-app"].firstMatch.tap()
    let field = app.searchFields["Search conversations..."]
    XCTAssertTrue(field.waitForExistence(timeout: 10), app.debugDescription)
    for round in 0..<3 {
      field.tap()
      field.typeText("flaky")
      XCTAssertTrue(app.staticTexts["Fix flaky auth test"].waitForExistence(timeout: 3), "round \(round)")
      XCTAssertFalse(app.staticTexts["Migrate settings to the new store"].exists, "round \(round): the search did not filter")
      close(app)
      sleep(3)
      XCTAssertFalse(app.keyboards.firstMatch.exists, "round \(round): search reopened")
      XCTAssertTrue(app.staticTexts["Migrate settings to the new store"].exists, "round \(round): the query was not cleared")
    }
  }

  @MainActor
  func testProjectsTabSearchCloses() {
    let app = XCUIApplication()
    app.launchArguments = ["-MCReset", "YES", "-MCDemo", "YES"]
    app.launch()
    XCTAssertTrue(app.tabBars.buttons["Projects"].waitForExistence(timeout: 30))
    app.tabBars.buttons["Projects"].tap()
    XCTAssertTrue(app.staticTexts["my-app"].waitForExistence(timeout: 10))
    let field = app.searchFields["Search projects..."]
    app.buttons["Search"].tap()
    XCTAssertTrue(field.waitForExistence(timeout: 3))
    close(app)
    sleep(3)
    XCTAssertFalse(field.exists && field.isHittable, "the projects search reopened")
  }

  /// The system's own dismiss button, whose label differs by placement.
  @MainActor
  private func close(_ app: XCUIApplication) {
    guard let close = ["Close", "close", "Cancel"].map({ app.buttons[$0] }).first(where: \.exists) else {
      return XCTFail("no close button\n\(app.debugDescription)")
    }
    close.tap()
  }
}

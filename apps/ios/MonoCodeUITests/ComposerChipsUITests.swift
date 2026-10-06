import XCTest

/// The composer's chip row on a streaming session: each chip opens its own
/// sheet (no tap falls through to the rows beneath), and picks show on the
/// chips.
final class ComposerChipsUITests: XCTestCase {
  @MainActor
  func testChipsOpenTheirSheetsAndShowPicks() {
    let app = XCUIApplication()
    app.launchArguments = ["-MCReset", "YES", "-MCDemo", "YES", "-MCOpen", "monocode-dev://session?id=s-perf"]
    app.launch()
    XCTAssertTrue(app.navigationBars["Profile the transcript scroll"].waitForExistence(timeout: 30))
    sleep(2)
    XCTAssertTrue(app.descendants(matching: .any)["Branch main"].exists, "the composer shows no branch")
    // The demo's turn reports its context; the ring opens the numbers.
    let ring = app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", "% context used")).firstMatch
    XCTAssertTrue(ring.waitForExistence(timeout: 15), "the context ring did not appear")
    shot("chips-row")
    ring.tap()
    XCTAssertTrue(app.navigationBars["Context"].waitForExistence(timeout: 3), "the ring did not open its sheet")
    shot("chips-context")
    app.navigationBars["Context"].buttons["Close"].tap()
    XCTAssertFalse(app.navigationBars["Context"].waitForExistence(timeout: 2))

    app.buttons["Add to message"].tap()
    XCTAssertTrue(app.navigationBars["Add to message"].waitForExistence(timeout: 3), "+ did not open its sheet")
    shot("chips-add")
    app.buttons["Plan mode"].tap()
    XCTAssertTrue(app.buttons["Plan mode. Remove"].waitForExistence(timeout: 3), "Plan did not show on the chips")
    app.buttons["Plan mode. Remove"].tap()
    XCTAssertFalse(app.buttons["Plan mode. Remove"].waitForExistence(timeout: 1))

    let modelChip = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model, ")).firstMatch
    XCTAssertTrue(modelChip.label.contains("Claude Opus 4.6"), modelChip.label)
    modelChip.tap()
    XCTAssertTrue(app.navigationBars["Model"].waitForExistence(timeout: 3), "the model chip did not open its sheet")
    app.buttons["Max"].tap()
    sleep(1)
    shot("chips-model-sheet")
    app.buttons["Claude Sonnet 5"].tap()
    XCTAssertFalse(app.navigationBars["Model"].waitForExistence(timeout: 2), "picking a model did not close the sheet")
    XCTAssertTrue(modelChip.label.contains("Claude Sonnet 5"), modelChip.label)
    XCTAssertTrue(modelChip.label.contains("effort Max"), "the effort pick was lost: \(modelChip.label)")

    let accessChip = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Access, ")).firstMatch
    accessChip.tap()
    XCTAssertTrue(app.navigationBars["Access"].waitForExistence(timeout: 3), "the access chip did not open its sheet")
    shot("chips-access")
    app.buttons["Full access"].tap()
    XCTAssertTrue(app.alerts["Allow full access?"].waitForExistence(timeout: 3), "Full access did not ask first")
    app.alerts.buttons["Allow full access"].tap()
    XCTAssertTrue(accessChip.waitForExistence(timeout: 3))
    XCTAssertEqual(accessChip.label, "Access, Full access")
    sleep(1)
    shot("chips-after")
  }

  @MainActor
  private func shot(_ name: String) {
    guard let folder = ProcessInfo.processInfo.environment["MC_SHOTS_DIR"] else { return }
    try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: folder).appending(path: "\(name).png"))
  }
}

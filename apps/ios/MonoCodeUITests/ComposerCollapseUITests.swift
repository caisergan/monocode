import XCTest

/// Reading back folds the composer to a capsule beside the jump button;
/// a tap, the jump or turning back opens it again.
final class ComposerCollapseUITests: XCTestCase {
  @MainActor
  func testReadingBackFoldsTheComposer() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-MCReset", "YES", "-MCDemo", "YES", "-MCOpen", "monocode-dev://session?id=s-perf"]
    app.launch()
    XCTAssertTrue(app.navigationBars["Profile the transcript scroll"].waitForExistence(timeout: 30))
    sleep(2)
    let folded = app.buttons["Composer"]
    // Open, the composer shows its chip row.
    let open = app.buttons["Add to message"]
    let jump = app.buttons["Jump to latest"]
    XCTAssertTrue(open.exists, "the composer starts open")
    XCTAssertFalse(folded.exists)

    // Reading back folds it, with the jump beside it.
    app.swipeDown()
    XCTAssertTrue(folded.waitForExistence(timeout: 3), "reading back did not fold the composer")
    XCTAssertTrue(jump.waitForExistence(timeout: 3))
    shot("composer-folded")

    // A tap opens it where the reader is; the jump floats above it and
    // still takes taps outside the bar.
    folded.tap()
    XCTAssertTrue(open.waitForExistence(timeout: 3), "a tap did not open the composer")
    XCTAssertTrue(jump.exists && jump.isHittable, "the jump left with the fold")
    sleep(1)
    shot("composer-open-reading")
    jump.tap()
    XCTAssertFalse(jump.waitForExistence(timeout: 1) && jump.isHittable, "the jump did not reach the end")
    XCTAssertFalse(folded.exists)

    // Reading back folds it again; turning back toward the latest opens it.
    sleep(1)
    shot("composer-at-end")
    app.swipeDown()
    shot("composer-second-fold")
    XCTAssertTrue(folded.waitForExistence(timeout: 3), "the fold did not come back after a tap opened it")
    let transcript = app.windows.firstMatch
    transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
      .press(forDuration: 0.05, thenDragTo: transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)))
    XCTAssertTrue(open.waitForExistence(timeout: 3), "turning back did not open the composer")
  }

  @MainActor
  private func shot(_ name: String) {
    guard let folder = ProcessInfo.processInfo.environment["MC_SHOTS_DIR"] else { return }
    try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: folder).appending(path: "\(name).png"))
  }
}

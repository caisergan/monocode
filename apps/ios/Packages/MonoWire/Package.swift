// swift-tools-version: 6.2

import PackageDescription

// Wire and session types, applySessionSync, windowing, summaries, and the
// desktop's turn and step grouping (16 §16.3). Foundation only, so it builds
// for macOS too and `swift test` runs on the Mac.
let package = Package(
  name: "MonoWire",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "MonoWire", targets: ["MonoWire"])
  ],
  targets: [
    .target(name: "MonoWire"),
    .testTarget(name: "MonoWireTests", dependencies: ["MonoWire"], resources: [.copy("Fixtures")]),
  ]
)

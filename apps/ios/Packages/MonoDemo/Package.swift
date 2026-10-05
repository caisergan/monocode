// swift-tools-version: 6.2

import PackageDescription

// The demo machine (12 §12.13): an in-process host behind the same Transport
// protocol as a real one, answering the read path from the state
// gen-fixtures.mjs exports from the Expo app's demoHost.ts. Builds for macOS
// too, so `swift test` runs on the Mac.
let package = Package(
  name: "MonoDemo",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "MonoDemo", targets: ["MonoDemo"])
  ],
  dependencies: [
    .package(path: "../MonoWire"),
    .package(path: "../MonoSync"),
  ],
  targets: [
    .target(name: "MonoDemo", dependencies: ["MonoWire", "MonoSync"], resources: [.copy("Resources/demo-state.json")]),
    .testTarget(name: "MonoDemoTests", dependencies: ["MonoDemo"], resources: [.copy("Fixtures")]),
  ]
)

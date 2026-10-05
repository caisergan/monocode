// swift-tools-version: 6.2

import PackageDescription

// The host runtime, transports, watch and the stores the screens read
// (12 §12.4 to §12.7). R1 is the read path; the outbox, cache and the real
// transports arrive with R2 and R3. Builds for macOS too, so `swift test`
// runs on the Mac.
let package = Package(
  name: "MonoSync",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "MonoSync", targets: ["MonoSync"])
  ],
  dependencies: [
    .package(path: "../MonoWire")
  ],
  targets: [
    .target(name: "MonoSync", dependencies: ["MonoWire"]),
    .testTarget(name: "MonoSyncTests", dependencies: ["MonoSync"]),
  ]
)

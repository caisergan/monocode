// swift-tools-version: 6.2

import PackageDescription

// The host runtime, transports, the race, pairing, the host registry, watch
// and the stores the screens read (12 §12.4 to §12.7). MonoChannel speaks the
// Noise channel and MonoStore keeps the cache and the Keychain. Builds for
// macOS too, so `swift test` runs on the Mac; `swift test --filter Interop`
// runs the client against a real host (16 §16.5).
let package = Package(
  name: "MonoSync",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "MonoSync", targets: ["MonoSync"])
  ],
  dependencies: [
    .package(path: "../MonoWire"),
    .package(path: "../MonoChannel"),
    .package(path: "../MonoStore"),
  ],
  targets: [
    .target(
      name: "MonoSync",
      dependencies: [
        "MonoWire", "MonoChannel",
        .product(name: "MonoStore", package: "MonoStore"),
        .product(name: "MonoKeychain", package: "MonoStore"),
      ]),
    .testTarget(name: "MonoSyncTests", dependencies: ["MonoSync"]),
  ]
)

// swift-tools-version: 6.2

import PackageDescription

// The SQLite cache and its migrations, and the Keychain wrapper (12 §12.6,
// 16 §16.3). GRDB is the one third-party package (16 §16.2). MonoKeychain is
// its own product so the notification extension links it without GRDB.
// Builds for macOS too, so `swift test` runs on the Mac.
let package = Package(
  name: "MonoStore",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "MonoStore", targets: ["MonoStore"]),
    .library(name: "MonoKeychain", targets: ["MonoKeychain"]),
  ],
  dependencies: [
    .package(url: "https://github.com/groue/GRDB.swift.git", exact: "7.11.1"),
    .package(path: "../MonoWire"),
  ],
  targets: [
    .target(name: "MonoKeychain"),
    .target(
      name: "MonoStore",
      dependencies: [
        .product(name: "GRDB", package: "GRDB.swift"),
        "MonoWire",
        "MonoKeychain",
      ]),
    .testTarget(
      name: "MonoStoreTests",
      dependencies: ["MonoStore", "MonoKeychain", .product(name: "GRDB", package: "GRDB.swift")]),
  ]
)

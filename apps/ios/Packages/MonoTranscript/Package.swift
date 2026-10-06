// swift-tools-version: 6.2

import PackageDescription

// The transcript (15 §15.4): the row builder from session blocks, CoreText
// layout on a background queue, and a UIKit view that paints recycled
// layers. iOS only; tests run on the simulator with `xcodebuild test`.
let package = Package(
  name: "MonoTranscript",
  platforms: [.iOS(.v26)],
  products: [
    .library(name: "MonoTranscript", targets: ["MonoTranscript"])
  ],
  dependencies: [
    .package(path: "../MonoWire"),
    .package(path: "../MonoDesign"),
  ],
  targets: [
    .target(
      name: "MonoTranscript", dependencies: ["MonoWire", "MonoDesign"],
      resources: [.copy("Resources/Fixtures"), .process("Resources/FileIcons.xcassets"), .copy("Resources/file-icons.json")]),
    .testTarget(name: "MonoTranscriptTests", dependencies: ["MonoTranscript"], resources: [.copy("Fixtures")]),
  ]
)

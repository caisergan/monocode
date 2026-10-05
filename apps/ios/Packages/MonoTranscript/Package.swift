// swift-tools-version: 6.2

import PackageDescription

// The transcript (15 §15.4): CoreText layout on a background queue and a
// UIKit view that paints recycled layers. iOS only; tests run on the
// simulator with `xcodebuild test`.
let package = Package(
  name: "MonoTranscript",
  platforms: [.iOS(.v26)],
  products: [
    .library(name: "MonoTranscript", targets: ["MonoTranscript"])
  ],
  targets: [
    .target(name: "MonoTranscript", resources: [.copy("Resources/Fixtures")]),
    .testTarget(name: "MonoTranscriptTests", dependencies: ["MonoTranscript"]),
  ]
)

// swift-tools-version: 6.2

import PackageDescription

// The phone's half of the secure channel (03 §3.4 to §3.6, 06 §6.1 to §6.3):
// Noise IK on CryptoKit, the record layer, the envelope, the offer and link
// codec, the pairing proof and confirmation code, and a transport-agnostic
// Channel. Apple frameworks only, so it builds for macOS too and `swift test`
// runs on the Mac.
let package = Package(
  name: "MonoChannel",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "MonoChannel", targets: ["MonoChannel"])
  ],
  targets: [
    .target(name: "MonoChannel"),
    .testTarget(name: "MonoChannelTests", dependencies: ["MonoChannel"], resources: [.copy("Fixtures")]),
  ]
)

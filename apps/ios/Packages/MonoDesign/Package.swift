// swift-tools-version: 6.2

import PackageDescription

let package = Package(
  name: "MonoDesign",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "MonoDesign", targets: ["MonoDesign"])
  ],
  targets: [
    .target(name: "MonoDesign"),
    .testTarget(name: "MonoDesignTests", dependencies: ["MonoDesign"]),
  ]
)

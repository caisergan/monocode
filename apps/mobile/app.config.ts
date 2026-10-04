import type { ExpoConfig } from "expo/config";
import type { Publisher } from "./publisher/types";

// Every publisher-specific value comes from publisher/<track>.json
// (docs/mobile/13 §13.5). The personal track is the maintainer's own build.
const track = process.env.MONOCODE_PUBLISHER ?? "personal";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const publisher = require(`./publisher/${track}.json`) as Publisher;

const config: ExpoConfig = {
  name: publisher.appName,
  slug: publisher.slug,
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: publisher.scheme,
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: publisher.bundleId,
    appleTeamId: publisher.appleTeamId,
    supportsTablet: true,
    icon: "./assets/expo.icon",
    infoPlist: {
      NSCameraUsageDescription: "Scan pairing codes and take photos to send to agents.",
      NSLocalNetworkUsageDescription: "Connect directly to your computers on this network.",
      // ws:// to LAN and tailnet addresses; the traffic inside is Noise-encrypted.
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: {
          "ts.net": { NSIncludesSubdomains: true, NSExceptionAllowsInsecureHTTPLoads: true },
        },
      },
      // ProMotion phones animate at 120 Hz.
      CADisableMinimumFrameDurationOnPhone: true,
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: publisher.androidPackage,
    adaptiveIcon: {
      backgroundColor: "#141414",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundImage: "./assets/images/android-icon-background.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    [
      "expo-camera",
      { cameraPermission: "Scan pairing codes and take photos to send to agents." },
    ],
    [
      "expo-splash-screen",
      { backgroundColor: "#141414", image: "./assets/images/splash-icon.png", imageWidth: 76 },
    ],
    ["expo-build-properties", { ios: { deploymentTarget: "16.4" } }],
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
  extra: { publisher: publisher.track },
};

export default config;

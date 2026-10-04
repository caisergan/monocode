export type Publisher = {
  track: "personal" | "official";
  appName: string;
  slug: string;
  bundleId: string;
  androidPackage: string;
  /** Custom URL scheme; pairing links use `<scheme>://pair#o=…`. */
  scheme: string;
  appleTeamId?: string;
  /** Universal-link domains serving /pair. None on the personal track. */
  linkDomains: string[];
};

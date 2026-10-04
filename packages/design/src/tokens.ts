// MonoCode's design tokens (docs/mobile/11 §11.2-11.6). Values marked
// "desktop" are copied from src/styles/index.css, appearance.ts and
// tabGroups.ts; parity.test.ts fails when either side changes alone.

export type Scheme = "dark" | "light";

/** Desktop: appearance.ts THEME_*_DEFAULT and ranges. */
export const TINT = {
  hue: { min: 0, max: 360, default: 240 },
  saturation: { min: 0, max: 100, default: 0 },
  darkLightness: { min: 0, max: 30, default: 9 },
} as const;

/** Desktop: index.css :root and html.theme-light. */
export const SCHEME = {
  dark: {
    contentLightness: 92,
    selection: { subtle: 8, normal: 10, strong: 12, hover: 15, emphasis: 20 },
    link: "#7dd3fc",
    skill: "#e8c547",
    mention: "#38bdf8",
    markdownHeading: "#f9a8c9",
  },
  light: {
    backgroundLightness: 97,
    contentLightness: 18,
    selection: { subtle: 5, normal: 6, strong: 7, hover: 10, emphasis: 14 },
    link: "hsl(211 92% 40%)",
    skill: "#a07c10",
    mention: "#0284c7",
    markdownHeading: "#be185d",
  },
} as const;

/** Desktop: --color-accent. */
export const ACCENT_HSL = [211, 92, 62] as const;

/** Desktop: tabGroups.ts TAB_GROUP_COLORS (index 0 is neutral). */
export const PROJECT_COLORS = [
  "hsl(210 8% 58%)",
  "hsl(211 92% 62%)",
  "hsl(12 80% 58%)",
  "hsl(45 90% 55%)",
  "hsl(142 55% 50%)",
  "hsl(330 70% 62%)",
  "hsl(280 55% 62%)",
  "hsl(175 55% 48%)",
  "hsl(25 85% 58%)",
] as const;

/** Desktop: tabGroupColor(). */
export function projectColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PROJECT_COLORS[(hash % (PROJECT_COLORS.length - 1)) + 1];
}

export const USER_ACCENT_PRESETS = {
  blue: "#4da3f5",
  violet: "#8b5cf6",
  pink: "#ec4899",
  red: "#ef4444",
  orange: "#f59e0b",
  green: "#10b981",
} as const;

/** Desktop: --motion-*. */
export const MOTION = {
  easeOut: [0.22, 1, 0.36, 1] as const,
  tabEaseOut: [0.3333, 0.6667, 0.6667, 1] as const,
  reorderMs: 160,
  tabCloseMs: 200,
  feedbackMs: 120,
  foldMs: 340,
};

/** Radii (11 §11.4), the desktop's values exactly. */
export const RADII = { xs: 4, sm: 6, md: 8, block: 10, lg: 12, xl: 16, full: 999 } as const;

/** Mobile type scale (11 §11.3, deviation M1): size / line height in pt. */
export const TYPE = {
  caption: { size: 11, line: 14 },
  meta: { size: 12, line: 16 },
  secondary: { size: 13, line: 18 },
  row: { size: 15, line: 20 },
  prose: { size: 16, line: 25 },
  composer: { size: 16, line: 24 },
  code: { size: 13, line: 19 },
  toolChip: { size: 14, line: 20 },
  screenTitle: { size: 17, line: 22 },
  pageHeading: { size: 22, line: 28 },
  emptyHeading: { size: 20, line: 26 },
  h1: { size: 22, line: 30 },
  h2: { size: 19, line: 27 },
  h3: { size: 18, line: 26 },
  h4: { size: 17, line: 25 },
} as const;

/** Status colours (11 §11.2), Tailwind values. */
export const STATUS = {
  dark: {
    attention: "#fbbf24",
    done: "#34d399",
    danger: "#f87171",
    doneCheck: "#2dd4bf",
  },
  light: {
    attention: "#b45309",
    done: "#047857",
    danger: "#ef4444",
    doneCheck: "#2dd4bf",
  },
} as const;

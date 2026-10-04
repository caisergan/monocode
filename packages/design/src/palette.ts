// One tint drives everything (11 §11.2): base and content come from the hue
// and saturation; every other colour is content at an alpha. React Native has
// no color-mix, so the mixes are computed here.

import { ACCENT_HSL, SCHEME, STATUS, TINT, type Scheme } from "./tokens";

export type Rgb = [number, number, number];

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function rgba([r, g, b]: Rgb, alpha: number): string {
  return `rgba(${r},${g},${b},${Number(alpha.toFixed(3))})`;
}

export function parseColor(value: string): Rgb {
  const hsl = value.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/);
  if (hsl) return hslToRgb(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
  const h = value.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

/** WCAG relative luminance above 0.179 takes black text (appearance.ts). */
export function accentForeground(color: string): "#000000" | "#ffffff" {
  const channels = parseColor(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

export type Appearance = {
  scheme: Scheme;
  hue?: number;
  saturation?: number;
  darkLightness?: number;
  userAccent?: string | null;
};

export type Palette = ReturnType<typeof palette>;

export function palette(appearance: Appearance) {
  const { scheme } = appearance;
  const hue = appearance.hue ?? TINT.hue.default;
  const sat = appearance.saturation ?? TINT.saturation.default;
  const dark = appearance.darkLightness ?? TINT.darkLightness.default;
  const tokens = SCHEME[scheme];
  const baseRgb = hslToRgb(hue, sat, scheme === "dark" ? dark : SCHEME.light.backgroundLightness);
  const contentRgb = hslToRgb(hue, sat, tokens.contentLightness);
  const content = (alpha: number) => rgba(contentRgb, alpha);
  const accent = hex(hslToRgb(...ACCENT_HSL));
  const status = STATUS[scheme];
  const selection = tokens.selection;
  const primary =
    appearance.userAccent ??
    (scheme === "dark" ? "#ffffff" : hex(contentRgb));
  const primaryText = appearance.userAccent
    ? accentForeground(appearance.userAccent)
    : scheme === "dark"
      ? "#000000"
      : hex(baseRgb);
  return {
    scheme,
    base: hex(baseRgb),
    content: hex(contentRgb),
    contentAlpha: content,
    stroke: content(0.07),
    border: { subtle: content(0.05), default: content(0.1), focus: content(0.2), dashed: content(0.3) },
    fill: {
      composer: content(0.03),
      hover: content(0.05),
      code: content(0.06),
      chip: content(0.08),
      bubble: content(0.1),
    },
    selection: {
      subtle: content(selection.subtle / 100),
      normal: content(selection.normal / 100),
      strong: content(selection.strong / 100),
      hover: content(selection.hover / 100),
      emphasis: content(selection.emphasis / 100),
    },
    text: {
      primary: content(0.9),
      prose: content(0.78),
      secondary: content(0.5),
      tertiary: content(0.45),
      faint: content(0.4),
      faintest: content(0.35),
      reasoning: content(0.48),
    },
    accent,
    primary,
    primaryText,
    link: scheme === "dark" ? "rgba(56,189,248,0.9)" : hex(parseColor(tokens.link)),
    skill: tokens.skill,
    mention: tokens.mention,
    markdownHeading: tokens.markdownHeading,
    status: { working: accent, ...status },
    scrim: "rgba(0,0,0,0.4)",
  };
}

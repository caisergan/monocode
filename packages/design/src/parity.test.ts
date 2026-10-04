// Fails when the desktop's tokens change without the phone's (11 §11.1 rule 1).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { palette } from "./palette";
import { ACCENT_HSL, MOTION, PROJECT_COLORS, SCHEME, TINT, projectColor } from "./tokens";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const css = readFileSync(`${root}src/styles/index.css`, "utf8");
const appearance = readFileSync(`${root}src/features/settings/model/appearance.ts`, "utf8");
const tabGroups = readFileSync(`${root}src/features/workspace/model/tabGroups.ts`, "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("\n}", start));
  const vars: Record<string, string> = {};
  for (const match of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[match[1]] = match[2].trim().replace(/\s+/g, " ");
  return vars;
}

describe("design parity with the desktop", () => {
  const rootVars = block(":root");
  const light = block("html.theme-light");
  const theme = block("@theme");

  it("matches the dark scheme", () => {
    expect(rootVars["theme-hue"]).toBe(String(TINT.hue.default));
    expect(rootVars["theme-saturation"]).toBe(`${TINT.saturation.default}%`);
    expect(rootVars["theme-dark-lightness"]).toBe(`${TINT.darkLightness.default}%`);
    expect(rootVars["content-lightness"]).toBe(`${SCHEME.dark.contentLightness}%`);
    expect(rootVars["link-color"]).toBe(SCHEME.dark.link);
    expect(rootVars["color-skill"]).toBe(SCHEME.dark.skill);
    expect(rootVars["color-mention"]).toBe(SCHEME.dark.mention);
    expect(rootVars["color-markdown-heading"]).toBe(SCHEME.dark.markdownHeading);
    const s = SCHEME.dark.selection;
    expect(
      ["subtle", "", "strong", "hover", "emphasis"].map((name) =>
        rootVars[`selection${name ? `-${name}` : ""}-strength`],
      ),
    ).toEqual([s.subtle, s.normal, s.strong, s.hover, s.emphasis].map((value) => `${value}%`));
  });

  it("matches the light scheme", () => {
    expect(light["background-lightness"]).toBe(`${SCHEME.light.backgroundLightness}%`);
    expect(light["content-lightness"]).toBe(`${SCHEME.light.contentLightness}%`);
    expect(light["link-color"]).toBe(SCHEME.light.link);
    expect(light["color-skill"]).toBe(SCHEME.light.skill);
    expect(light["color-mention"]).toBe(SCHEME.light.mention);
    expect(light["color-markdown-heading"]).toBe(SCHEME.light.markdownHeading);
    const s = SCHEME.light.selection;
    expect(
      ["subtle", "", "strong", "hover", "emphasis"].map((name) =>
        light[`selection${name ? `-${name}` : ""}-strength`],
      ),
    ).toEqual([s.subtle, s.normal, s.strong, s.hover, s.emphasis].map((value) => `${value}%`));
  });

  it("matches the accent, stroke mix and motion", () => {
    expect(theme["color-accent"]).toBe(`hsl(${ACCENT_HSL[0]} ${ACCENT_HSL[1]}% ${ACCENT_HSL[2]}%)`);
    expect(theme["color-stroke"]).toBe("color-mix(in srgb, var(--color-content) 7%, transparent)");
    expect(rootVars["motion-ease-out"]).toBe(`cubic-bezier(${MOTION.easeOut.join(", ")})`);
    expect(rootVars["motion-feedback-duration"]).toBe(`${MOTION.feedbackMs}ms`);
    expect(rootVars["motion-reorder-duration"]).toBe(`${MOTION.reorderMs}ms`);
  });

  it("matches the tint ranges and project colours", () => {
    for (const [name, key] of [
      ["HUE", "hue"],
      ["SATURATION", "saturation"],
      ["DARK_LIGHTNESS", "darkLightness"],
    ] as const) {
      const range = TINT[key];
      expect(appearance).toContain(`THEME_${name}_MIN = ${range.min};`);
      expect(appearance).toContain(`THEME_${name}_MAX = ${range.max};`);
      expect(appearance).toContain(`THEME_${name}_DEFAULT = ${range.default};`);
    }
    for (const color of PROJECT_COLORS) expect(tabGroups).toContain(`"${color}"`);
    expect(projectColor("my-app")).toMatch(/^hsl\(/);
  });

  it("resolves the default tint to the documented values", () => {
    expect(palette({ scheme: "dark" })).toMatchObject({ base: "#171717", content: "#ebebeb", accent: "#459bf7" });
    expect(palette({ scheme: "light" })).toMatchObject({ base: "#f7f7f7", content: "#2e2e2e" });
  });
});

import { expect, it } from "vitest";
import {
  browserPreviewPath,
  browserPreviewUrl,
  isBrowserPreviewUrl,
} from "./browserPreview";

it("keeps path segments so relative links resolve beside the page", () => {
  expect(browserPreviewUrl("/Users/me/my site/index.html", false)).toBe(
    "monocode-preview://localhost/Users/me/my%20site/index.html",
  );
  expect(
    new URL("./style.css", browserPreviewUrl("/a/b/index.html", false)).href,
  ).toBe("monocode-preview://localhost/a/b/style.css");
});

it("uses the localhost host form and keeps the drive letter on Windows", () => {
  expect(browserPreviewUrl("C:/Users/me/#1/page.html", true)).toBe(
    "http://monocode-preview.localhost/C:/Users/me/%231/page.html",
  );
  expect(browserPreviewUrl("C:\\site\\index.html", true)).toBe(
    "http://monocode-preview.localhost/C:/site/index.html",
  );
});

it("recognizes preview URLs on every platform form", () => {
  expect(isBrowserPreviewUrl("monocode-preview://localhost/a.html")).toBe(true);
  expect(isBrowserPreviewUrl("http://monocode-preview.localhost/a.html")).toBe(
    true,
  );
  expect(isBrowserPreviewUrl("http://localhost:5173/")).toBe(false);
});

it("maps a preview URL back to its file", () => {
  expect(
    browserPreviewPath(browserPreviewUrl("/Users/me/my site/#1.html", false)),
  ).toBe("/Users/me/my site/#1.html");
  expect(
    browserPreviewPath(browserPreviewUrl("C:/site/index.html", true)),
  ).toBe("C:/site/index.html");
  expect(browserPreviewPath("http://localhost:5173/a.html")).toBeNull();
});

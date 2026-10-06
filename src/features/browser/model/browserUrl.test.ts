import { expect, it } from "vitest";
import {
  browserFrameSandbox,
  browserTabLabel,
  normalizeBrowserUrl,
} from "./browserUrl";

it("guesses http for local dev servers and https for other hosts", () => {
  expect(normalizeBrowserUrl("localhost:5173")).toBe("http://localhost:5173/");
  expect(normalizeBrowserUrl(" 127.0.0.1:3000/app ")).toBe(
    "http://127.0.0.1:3000/app",
  );
  expect(normalizeBrowserUrl("example.com/docs")).toBe(
    "https://example.com/docs",
  );
  expect(normalizeBrowserUrl("http://example.com")).toBe("http://example.com/");
});

it("rejects schemes and text the frame should never load", () => {
  expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull();
  expect(normalizeBrowserUrl("file:///etc/passwd")).toBeNull();
  expect(normalizeBrowserUrl("data:text/html,<p>")).toBeNull();
  expect(normalizeBrowserUrl("tauri://localhost/")).toBeNull();
  expect(normalizeBrowserUrl("just some words")).toBeNull();
  expect(normalizeBrowserUrl("intranet")).toBeNull();
  expect(normalizeBrowserUrl("")).toBeNull();
});

it("keeps preview-protocol URLs as they are", () => {
  const url = "monocode-preview://localhost/Users/me/site/index.html";
  expect(normalizeBrowserUrl(url)).toBe(url);
});

it("gives sites their own origin but keeps preview and app-origin pages opaque", () => {
  const app = "tauri://localhost";
  expect(browserFrameSandbox("http://localhost:5173/", app)).toContain(
    "allow-same-origin",
  );
  expect(
    browserFrameSandbox("monocode-preview://localhost/a/index.html", app),
  ).not.toContain("allow-same-origin");
  expect(
    browserFrameSandbox("http://monocode-preview.localhost/C:/a.html", app),
  ).not.toContain("allow-same-origin");
  expect(
    browserFrameSandbox("http://localhost:1420/", "http://localhost:1420"),
  ).not.toContain("allow-same-origin");
  expect(
    browserFrameSandbox("monocode-remote://localhost/env-1/a/index.html", app),
  ).not.toContain("allow-same-origin");
});

it("labels previews by file and sites by host", () => {
  expect(browserTabLabel("monocode-preview://localhost/a/my%20page.html")).toBe(
    "my page.html",
  );
  expect(browserTabLabel("http://localhost:5173/settings")).toBe(
    "localhost:5173",
  );
});

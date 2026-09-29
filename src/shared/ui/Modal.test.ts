// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Modal, ModalPanel } from "./Modal";

describe("ModalPanel", () => {
  it("names the dialog and close action", () => {
    const markup = renderToStaticMarkup(
      createElement(ModalPanel, {
        title: "Example",
        description: "A reusable shell",
        onClose: vi.fn(),
        children: "Body",
      }),
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("modal-panel");
    expect(markup).toContain("Example");
    expect(markup).toContain("A reusable shell");
    expect(markup).toContain("Body");
    expect(markup).toContain('aria-label="Close"');
  });

  it("can preserve an accessible title with a minimal visual header", () => {
    const markup = renderToStaticMarkup(
      createElement(ModalPanel, {
        title: "Authentication required",
        description: "Sign in to continue.",
        minimalHeader: true,
        onClose: vi.fn(),
        children: "Provider login",
      }),
    );

    expect(markup).toContain('class="sr-only"');
    expect(markup).toContain("Authentication required");
    expect(markup).toContain("Provider login");
  });
});

describe("Modal", () => {
  it("marks the page while open so glass under it can pause", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        createElement(Modal, {
          title: "Example",
          onClose: vi.fn(),
          children: "Body",
        }),
      ),
    );
    expect(document.querySelector("body > [data-dialog-layer]")).not.toBeNull();

    act(() => root.unmount());
    expect(document.querySelector("[data-dialog-layer]")).toBeNull();
    vi.unstubAllGlobals();
  });
});

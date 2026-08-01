/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vite-plus/test";

import type { Extension } from "../../BlockNoteExtension.js";
import { ExtensionLifecycle } from "./ExtensionLifecycle.js";

describe("ExtensionLifecycle", () => {
  it("uses the mounted document realm and aborts cleanup exactly once", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const mountedRealm = iframe.contentWindow! as Window & typeof globalThis;
    const root = iframe.contentDocument!;
    root.body.innerHTML = '<div id="editor"></div>';
    const dom = root.querySelector<HTMLElement>("#editor")!;
    const onAbort = vi.fn();
    const cleanup = vi.fn();
    const destroy = vi.fn();
    let signal: AbortSignal | undefined;
    const extension: Extension = {
      key: "document-realm",
      mount(context) {
        signal = context.signal;
        context.signal.addEventListener("abort", onAbort);
        return cleanup;
      },
      destroy,
    };
    const lifecycle = new ExtensionLifecycle();

    expect(
      Object.is(mountedRealm.AbortSignal.prototype, AbortSignal.prototype),
    ).toBe(false);
    lifecycle.mount(extension, { dom, root });

    expect(Object.getPrototypeOf(signal)).toBe(
      mountedRealm.AbortSignal.prototype,
    );

    lifecycle.unmountAll();
    lifecycle.unmountAll();
    lifecycle.destroy([extension]);
    lifecycle.destroy([extension]);

    expect(signal?.aborted).toBe(true);
    expect(onAbort).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    iframe.remove();
  });

  it("falls back to the host realm when the document has no view", () => {
    const root = document.implementation.createHTMLDocument();
    const dom = root.createElement("div");
    let signal: AbortSignal | undefined;
    const extension: Extension = {
      key: "host-fallback",
      mount(context) {
        signal = context.signal;
      },
    };
    const lifecycle = new ExtensionLifecycle();

    expect(root.defaultView).toBeNull();
    lifecycle.mount(extension, { dom, root });

    expect(Object.getPrototypeOf(signal)).toBe(AbortSignal.prototype);
    lifecycle.unmountAll();
    expect(signal?.aborted).toBe(true);
  });
});

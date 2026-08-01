import type { Extension } from "../../BlockNoteExtension.js";

export class ExtensionLifecycle {
  private readonly abortControllers = new Map<Extension, AbortController>();
  private readonly disposed = new Set<Extension>();
  private readonly subscriptions: (() => void)[] = [];

  public addSubscription(unsubscribe: () => void) {
    this.subscriptions.push(unsubscribe);
  }

  public isDisposed(extension: Extension) {
    return this.disposed.has(extension);
  }

  public mount(
    extension: Extension,
    context: {
      readonly dom: HTMLElement;
      readonly root: Document | ShadowRoot;
    },
  ) {
    if (!extension.mount || this.disposed.has(extension)) {
      return;
    }

    this.abort(extension);
    const abortController = new AbortController();
    this.abortControllers.set(extension, abortController);
    try {
      const cleanup = extension.mount({
        ...context,
        signal: abortController.signal,
      });
      if (cleanup) {
        if (abortController.signal.aborted) {
          cleanup();
        } else {
          abortController.signal.addEventListener("abort", cleanup, {
            once: true,
          });
        }
      }
    } catch (error) {
      this.abort(extension);
      throw error;
    }
  }

  public unmountAll() {
    let failure: unknown;
    for (const extension of [...this.abortControllers.keys()]) {
      try {
        this.abort(extension);
      } catch (error) {
        failure ??= error;
      }
    }

    if (failure) {
      throw failure;
    }
  }

  public dispose(extension: Extension) {
    if (this.disposed.has(extension)) {
      return;
    }

    this.disposed.add(extension);
    let failure: unknown;
    try {
      this.abort(extension);
    } catch (error) {
      failure = error;
    }

    try {
      extension.destroy?.();
    } catch (error) {
      failure ??= error;
    }

    if (failure) {
      throw failure;
    }
  }

  public destroy(extensions: readonly Extension[]) {
    let failure: unknown;

    for (const unsubscribe of this.subscriptions.splice(0).reverse()) {
      try {
        unsubscribe();
      } catch (error) {
        failure ??= error;
      }
    }

    for (const extension of [...extensions].reverse()) {
      try {
        this.dispose(extension);
      } catch (error) {
        failure ??= error;
      }
    }

    for (const extension of [...this.abortControllers.keys()]) {
      try {
        this.abort(extension);
      } catch (error) {
        failure ??= error;
      }
    }

    if (failure) {
      throw failure;
    }
  }

  private abort(extension: Extension) {
    const abortController = this.abortControllers.get(extension);
    this.abortControllers.delete(extension);
    abortController?.abort();
  }
}

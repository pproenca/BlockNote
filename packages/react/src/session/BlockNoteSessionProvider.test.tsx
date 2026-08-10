import type { AnyBlockNoteDocumentDefinition } from "@blocknote/core";
import type {
  BlockNoteSession,
  BlockNoteSessionOptions,
  BlockNoteSessionState,
} from "@blocknote/collaboration";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { useBlockNoteSessionState } from "../hooks/useBlockNoteSessionState.js";
import { useCreateBlockNoteSession } from "../hooks/useCreateBlockNoteSession.js";

const mocked = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@blocknote/collaboration", () => ({
  createBlockNoteSession: mocked.create,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const access = Object.freeze({
  mode: "editing" as const,
  edit: true,
  comment: true,
  suggest: true,
  review: true,
});

function fakeSession(id: string) {
  let state: BlockNoteSessionState = Object.freeze({
    phase: "ready",
    readiness: "local",
    connection: "connecting",
    durability: "saved",
    access,
  });
  const listeners = new Set<(value: BlockNoteSessionState) => void>();
  const destroy = vi.fn(async () => undefined);
  const session = {
    id,
    document: { id } as unknown as AnyBlockNoteDocumentDefinition,
    editor: {},
    getState: () => state,
    subscribe(listener: (value: BlockNoteSessionState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    on: () => () => undefined,
    applyRecovery: async () => undefined,
    discardRecovery: async () => undefined,
    destroy,
  } as unknown as BlockNoteSession<AnyBlockNoteDocumentDefinition> & {
    id: string;
  };
  return {
    destroy,
    session,
    publish(patch: Partial<BlockNoteSessionState>) {
      state = Object.freeze({ ...state, ...patch });
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

describe("BlockNote session React facade", () => {
  it("destroys stale Strict Mode startups exactly once", async () => {
    const pending: Array<{
      resolve(value: BlockNoteSession<AnyBlockNoteDocumentDefinition>): void;
    }> = [];
    mocked.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push({ resolve });
        }),
    );
    const options =
      {} as BlockNoteSessionOptions<AnyBlockNoteDocumentDefinition>;
    const published: string[] = [];
    const Harness = () => {
      const session = useCreateBlockNoteSession(options) as
        | (BlockNoteSession<AnyBlockNoteDocumentDefinition> & { id: string })
        | null;
      if (session) {
        published.push(session.id);
      }
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
    });
    expect(pending).toHaveLength(2);
    const stale = fakeSession("stale");
    const latest = fakeSession("latest");
    await act(async () => {
      pending[0]!.resolve(stale.session);
      pending[1]!.resolve(latest.session);
      await Promise.resolve();
    });
    expect(stale.destroy).toHaveBeenCalledTimes(1);
    expect(latest.destroy).not.toHaveBeenCalled();
    expect(published).toContain("latest");
    await act(async () => root.unmount());
    expect(latest.destroy).toHaveBeenCalledTimes(1);
  });

  it("suppresses rerenders when an unselected state field changes", async () => {
    const test = fakeSession("session");
    let renders = 0;
    const Consumer = () => {
      useBlockNoteSessionState({
        session: test.session,
        select: (state) => state.durability,
      });
      renders += 1;
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Consumer />));
    const initial = renders;
    await act(async () => test.publish({ connection: "offline" }));
    expect(renders).toBe(initial);
    await act(async () => test.publish({ durability: "offline" }));
    expect(renders).toBeGreaterThan(initial);
    await act(async () => root.unmount());
  });
});

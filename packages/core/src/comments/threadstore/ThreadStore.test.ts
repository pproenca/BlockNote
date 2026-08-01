import { describe, expect, it } from "vite-plus/test";

import type { CommentData, ThreadData } from "../types.js";
import { CallbackThreadStoreAuth } from "./CallbackThreadStoreAuth.js";
import { ThreadStore } from "./ThreadStore.js";

type Metadata = Record<string, never>;
type LegacyThread = ThreadData<Metadata, Metadata>;

class LegacyThreadStore extends ThreadStore<Metadata, Metadata> {
  public addThreadToDocument = undefined;

  constructor(private readonly threads: Map<string, LegacyThread>) {
    super(new CallbackThreadStoreAuth());
  }

  async createThread(): Promise<LegacyThread> {
    throw new Error("unused");
  }

  async addComment(): Promise<CommentData<Metadata>> {
    throw new Error("unused");
  }

  async updateComment() {}

  async deleteComment() {}

  async deleteThread() {}

  async resolveThread() {}

  async unresolveThread() {}

  async addReaction() {}

  async deleteReaction() {}

  getThread(threadId: string) {
    return this.threads.get(threadId);
  }

  getThreads() {
    return new Map(this.threads);
  }

  subscribe() {
    return () => {};
  }
}

describe("legacy ThreadStore snapshots", () => {
  it("assigns each observation a per-instance monotonic revision", () => {
    const rows = new Map<string, LegacyThread>();
    const store = new LegacyThreadStore(rows);
    const otherStore = new LegacyThreadStore(new Map());

    const first = store.getSnapshot();
    rows.set("new", thread("new"));
    const second = store.getSnapshot();
    const other = otherStore.getSnapshot();

    expect(second.revision.sequence).toBe(first.revision.sequence + 1);
    expect(second.revision.token).not.toBe(first.revision.token);
    expect(other.revision.sequence).toBe(1);
    expect(other.revision.token).not.toBe(first.revision.token);
    expect(first.threads.has("new")).toBe(false);
    expect(second.threads.has("new")).toBe(true);
  });
});

function thread(id: string): LegacyThread {
  return {
    type: "thread",
    id,
    createdAt: new Date(1),
    updatedAt: new Date(1),
    comments: [],
    resolved: false,
    metadata: {},
  };
}

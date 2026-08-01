import type {
  BlockNoteThread,
  BlockNoteThreadSnapshot,
  BlockNoteThreadStoreCommitReceipt,
  BlockNoteThreadStoreRevision,
} from "../types.js";
import {
  createPublicThreadSnapshot,
  normalizeThreadSnapshot,
  readThreadSnapshotCompleteness,
} from "./immutableThreadSnapshot.js";
import {
  compareThreadStoreRevision,
  invalidThreadStoreState,
  normalizeThreadStoreCommitReceipt,
  readThreadStoreRevision,
  sameThreadStoreRevision,
  threadStoreRevisionConflict,
} from "./threadStoreCommit.js";

type Thread<TThreadMetadata, TCommentMetadata> = BlockNoteThread<
  TThreadMetadata,
  TCommentMetadata
>;

export type ThreadStoreTransition = {
  readonly status: "applied" | "duplicate" | "stale";
};

type DeletionReceipt = {
  readonly threadId: string;
  readonly revision: BlockNoteThreadStoreRevision;
};

/** Explicit committed revision/change state for createThreadStore. */
export class CommittedThreadStoreState<TThreadMetadata, TCommentMetadata> {
  private revision: BlockNoteThreadStoreRevision;
  private threads: Map<string, Thread<TThreadMetadata, TCommentMetadata>>;
  private completeness: "partial" | "complete";
  private nextCursor: string | undefined;
  private seenCursors: Set<string>;
  private pageGenerationThreadIds: Set<string>;
  private currentDeletion: DeletionReceipt | undefined;
  private publicSnapshot: BlockNoteThreadSnapshot<
    TThreadMetadata,
    TCommentMetadata
  >;

  constructor(
    initialValue: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>,
  ) {
    const revision = readThreadStoreRevision(initialValue);
    const initial = normalizeThreadSnapshot(initialValue, revision);
    this.revision = initial.revision;
    this.threads = initial.threads;
    this.completeness = initial.completeness;
    this.nextCursor = initial.nextCursor;
    this.seenCursors = cursorSet(initial.nextCursor);
    this.pageGenerationThreadIds = new Set(initial.threads.keys());
    this.publicSnapshot = createPublicThreadSnapshot(initial);
  }

  getSnapshot() {
    return this.publicSnapshot;
  }

  applyCommit(
    value: BlockNoteThreadStoreCommitReceipt<TThreadMetadata, TCommentMetadata>,
  ): ThreadStoreTransition {
    const revision = readThreadStoreRevision(value);
    const comparison = compareThreadStoreRevision(this.revision, revision);
    if (comparison > 0) {
      return { status: "stale" };
    }
    if (comparison === 0) {
      return { status: "duplicate" };
    }

    const receipt = normalizeThreadStoreCommitReceipt(value, revision);
    const contiguous = revision.sequence === this.revision.sequence + 1;
    this.beginGeneration(revision, contiguous);

    if (receipt.change.type === "delete") {
      this.threads.delete(receipt.change.threadId);
      this.pageGenerationThreadIds.delete(receipt.change.threadId);
      this.currentDeletion = Object.freeze({
        threadId: receipt.change.threadId,
        revision,
      });
    } else {
      this.threads.set(receipt.change.thread.id, receipt.change.thread);
      this.pageGenerationThreadIds.add(receipt.change.thread.id);
    }

    this.publish();
    return { status: "applied" };
  }

  applySourceSnapshot(
    value: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>,
  ): ThreadStoreTransition {
    const revision = readThreadStoreRevision(value);
    const comparison = compareThreadStoreRevision(this.revision, revision);
    if (comparison > 0) {
      return { status: "stale" };
    }

    let knownCompleteness: "partial" | "complete" | undefined;
    if (comparison === 0) {
      if (this.completeness === "complete") {
        return { status: "duplicate" };
      }
      knownCompleteness = readThreadSnapshotCompleteness(value);
      if (knownCompleteness !== "complete") {
        return { status: "duplicate" };
      }
    }

    const incoming = normalizeThreadSnapshot(
      value,
      revision,
      knownCompleteness,
    );
    const deletion = comparison === 0 ? this.currentDeletion : undefined;
    this.beginGeneration(revision, false);
    this.threads = new Map(incoming.threads);
    if (deletion && sameThreadStoreRevision(deletion.revision, revision)) {
      this.threads.delete(deletion.threadId);
    }
    this.completeness = incoming.completeness;
    this.nextCursor = incoming.nextCursor;
    this.seenCursors = cursorSet(incoming.nextCursor);
    this.pageGenerationThreadIds = new Set(this.threads.keys());
    this.publish();
    return { status: "applied" };
  }

  applyPage(
    value: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>,
    request: {
      readonly revision: BlockNoteThreadStoreRevision;
      readonly cursor?: string;
    },
  ): ThreadStoreTransition {
    const requestedRevision = readThreadStoreRevision(request);
    const responseRevision = readThreadStoreRevision(value);
    if (!sameThreadStoreRevision(requestedRevision, responseRevision)) {
      if (requestedRevision.sequence === responseRevision.sequence) {
        throw threadStoreRevisionConflict(requestedRevision.sequence);
      }
      return { status: "stale" };
    }

    const currentComparison = compareThreadStoreRevision(
      this.revision,
      requestedRevision,
    );
    if (
      currentComparison !== 0 ||
      this.completeness === "complete" ||
      this.nextCursor !== request.cursor
    ) {
      return { status: "stale" };
    }

    const page = normalizeThreadSnapshot(value, responseRevision);
    assertPageProgress(page, request.cursor, this.seenCursors);
    const threads = new Map(this.threads);
    const seenCursors = new Set(this.seenCursors);
    if (page.nextCursor !== undefined) {
      seenCursors.add(page.nextCursor);
    }
    const generationThreadIds = new Set(this.pageGenerationThreadIds);
    for (const [threadId, thread] of page.threads) {
      if (
        this.currentDeletion?.threadId === threadId &&
        sameThreadStoreRevision(this.currentDeletion.revision, responseRevision)
      ) {
        continue;
      }
      threads.set(threadId, thread);
      generationThreadIds.add(threadId);
    }

    if (page.completeness === "complete") {
      for (const threadId of threads.keys()) {
        if (!generationThreadIds.has(threadId)) {
          threads.delete(threadId);
        }
      }
      this.currentDeletion = undefined;
    }

    this.threads = threads;
    this.seenCursors = seenCursors;
    this.pageGenerationThreadIds = generationThreadIds;
    this.completeness = page.completeness;
    this.nextCursor = page.nextCursor;
    this.publish();
    return { status: "applied" };
  }

  getDeletionReceiptCountForTesting() {
    return this.currentDeletion ? 1 : 0;
  }

  private beginGeneration(
    revision: BlockNoteThreadStoreRevision,
    retainKnownRows: boolean,
  ) {
    if (!retainKnownRows) {
      this.threads = new Map();
      this.completeness = "partial";
    }
    this.revision = revision;
    this.nextCursor = undefined;
    this.seenCursors = new Set();
    this.pageGenerationThreadIds = new Set(this.threads.keys());
    this.currentDeletion = undefined;
  }

  private publish() {
    this.publicSnapshot = createPublicThreadSnapshot({
      revision: this.revision,
      threads: this.threads,
      completeness: this.completeness,
      ...(this.nextCursor === undefined ? {} : { nextCursor: this.nextCursor }),
    });
  }
}

function assertPageProgress(
  page: {
    readonly completeness: "partial" | "complete";
    readonly nextCursor?: string;
  },
  requestCursor: string | undefined,
  seenCursors: ReadonlySet<string>,
) {
  if (page.completeness === "complete" && page.nextCursor !== undefined) {
    throw invalidThreadStoreState(
      "A complete thread page cannot expose a next cursor.",
    );
  }
  if (
    page.completeness === "partial" &&
    (page.nextCursor === undefined ||
      page.nextCursor === requestCursor ||
      seenCursors.has(page.nextCursor))
  ) {
    throw invalidThreadStoreState(
      "A partial thread page must advance to an unseen cursor.",
    );
  }
}

function cursorSet(cursor: string | undefined) {
  return cursor === undefined ? new Set<string>() : new Set([cursor]);
}

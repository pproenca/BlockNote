import type {
  BlockNoteThread,
  BlockNoteThreadSnapshot,
  BlockNoteThreadStoreChange,
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
  normalizeThreadStoreCommitReceipt,
  readThreadStoreRevision,
  sameThreadStoreRevision,
  threadStoreRevisionConflict,
} from "./threadStoreCommit.js";

type Thread<TThreadMetadata, TCommentMetadata> = BlockNoteThread<
  TThreadMetadata,
  TCommentMetadata
>;

type AppliedChange<TThreadMetadata, TCommentMetadata> = {
  readonly changed: boolean;
  readonly change?: BlockNoteThreadStoreChange<
    TThreadMetadata,
    TCommentMetadata
  >;
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
  private pageGenerationThreadIds: Set<string>;
  private readonly deletionReceipts = new Map<string, DeletionReceipt>();
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
    this.pageGenerationThreadIds = new Set(initial.threads.keys());
    this.publicSnapshot = createPublicThreadSnapshot(initial);
  }

  getSnapshot() {
    return this.publicSnapshot;
  }

  applyCommit(
    value: BlockNoteThreadStoreCommitReceipt<TThreadMetadata, TCommentMetadata>,
  ): AppliedChange<TThreadMetadata, TCommentMetadata> {
    const revision = readThreadStoreRevision(value);
    const comparison = compareThreadStoreRevision(this.revision, revision);

    if (comparison >= 0) {
      return { changed: false };
    }

    const change = normalizeThreadStoreCommitReceipt(value, revision).change;

    const contiguous = revision.sequence === this.revision.sequence + 1;
    this.garbageCollectOlderDeletionReceipts(revision);
    this.revision = revision;
    this.nextCursor = undefined;
    this.pageGenerationThreadIds = new Set();
    if (!contiguous) {
      this.completeness = "partial";
    }

    if (change.type === "delete") {
      this.threads.delete(change.threadId);
      this.deletionReceipts.set(
        change.threadId,
        Object.freeze({ threadId: change.threadId, revision }),
      );
    } else {
      this.threads.set(change.thread.id, change.thread);
      this.pageGenerationThreadIds.add(change.thread.id);
      this.deletionReceipts.delete(change.thread.id);
    }

    this.publish();
    return { changed: true, change };
  }

  applySourceSnapshot(
    value: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>,
  ) {
    const revision = readThreadStoreRevision(value);
    const comparison = compareThreadStoreRevision(this.revision, revision);
    if (
      comparison > 0 ||
      (comparison === 0 && this.completeness === "complete")
    ) {
      return false;
    }
    if (
      comparison === 0 &&
      readThreadSnapshotCompleteness(value) !== "complete"
    ) {
      return false;
    }

    const incoming = normalizeThreadSnapshot(value, revision);
    this.revision = incoming.revision;
    this.completeness = incoming.completeness;
    this.nextCursor = incoming.nextCursor;
    this.pageGenerationThreadIds = new Set(incoming.threads.keys());

    if (incoming.completeness === "complete") {
      this.threads = this.withoutCurrentRevisionDeletes(incoming.threads);
      this.garbageCollectDeletionReceipts(incoming.revision);
    } else if (comparison < 0) {
      for (const [threadId, thread] of incoming.threads) {
        this.threads.set(threadId, thread);
        this.deletionReceipts.delete(threadId);
      }
    }

    this.publish();
    return true;
  }

  applyPage(
    value: BlockNoteThreadSnapshot<TThreadMetadata, TCommentMetadata>,
    request: {
      readonly revision: BlockNoteThreadStoreRevision;
      readonly cursor?: string;
    },
  ) {
    const requestedRevision = readThreadStoreRevision(request);
    const responseRevision = readThreadStoreRevision(value);
    if (!sameThreadStoreRevision(requestedRevision, responseRevision)) {
      if (requestedRevision.sequence === responseRevision.sequence) {
        throw threadStoreRevisionConflict(requestedRevision.sequence);
      }
      return false;
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
      return false;
    }

    const page = normalizeThreadSnapshot(value, responseRevision);
    for (const [threadId, thread] of page.threads) {
      const deletion = this.deletionReceipts.get(threadId);
      if (
        deletion &&
        sameThreadStoreRevision(deletion.revision, responseRevision)
      ) {
        continue;
      }
      this.threads.set(threadId, thread);
      this.pageGenerationThreadIds.add(threadId);
      this.deletionReceipts.delete(threadId);
    }

    this.completeness = page.completeness;
    this.nextCursor = page.nextCursor;
    if (page.completeness === "complete") {
      for (const threadId of this.threads.keys()) {
        if (!this.pageGenerationThreadIds.has(threadId)) {
          this.threads.delete(threadId);
        }
      }
      this.garbageCollectDeletionReceipts(page.revision);
    }

    this.publish();
    return true;
  }

  getDeletionReceiptCountForTesting() {
    return this.deletionReceipts.size;
  }

  private withoutCurrentRevisionDeletes(
    incoming: Map<string, Thread<TThreadMetadata, TCommentMetadata>>,
  ) {
    const next = new Map(incoming);
    for (const deletion of this.deletionReceipts.values()) {
      if (sameThreadStoreRevision(deletion.revision, this.revision)) {
        next.delete(deletion.threadId);
      }
    }
    return next;
  }

  private garbageCollectDeletionReceipts(
    authoritativeRevision: BlockNoteThreadStoreRevision,
  ) {
    for (const [threadId, receipt] of this.deletionReceipts) {
      if (receipt.revision.sequence <= authoritativeRevision.sequence) {
        this.deletionReceipts.delete(threadId);
      }
    }
  }

  private garbageCollectOlderDeletionReceipts(
    acceptedRevision: BlockNoteThreadStoreRevision,
  ) {
    for (const [threadId, receipt] of this.deletionReceipts) {
      if (receipt.revision.sequence < acceptedRevision.sequence) {
        this.deletionReceipts.delete(threadId);
      }
    }
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

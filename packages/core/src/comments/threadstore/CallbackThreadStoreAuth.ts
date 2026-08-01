import { ThreadStoreAuth } from "./ThreadStoreAuth.js";

/** Default authorization for callback-backed stores; adapters authorize writes. */
export class CallbackThreadStoreAuth<
  TThreadMetadata,
  TCommentMetadata,
> extends ThreadStoreAuth<TThreadMetadata, TCommentMetadata> {
  canCreateThread() {
    return true;
  }

  canAddComment() {
    return true;
  }

  canUpdateComment() {
    return true;
  }

  canDeleteComment() {
    return true;
  }

  canDeleteThread() {
    return true;
  }

  canResolveThread() {
    return true;
  }

  canUnresolveThread() {
    return true;
  }

  canAddReaction() {
    return true;
  }

  canDeleteReaction() {
    return true;
  }
}

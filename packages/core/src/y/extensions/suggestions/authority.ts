import { uuidv4 } from "lib0/random";

import type {
  NativeReviewAuthorityGrant,
  NativeReviewAuthorityRequest,
  NativeSuggestionsBinding,
} from "./model.js";

type TestAuthorityState = { status: "issued" | "revoked" | "consumed" };

const testAuthorities = new WeakMap<object, TestAuthorityState>();
const consumedNonces = new WeakMap<NativeSuggestionsBinding, Set<string>>();

function equalRequest(
  left: NativeReviewAuthorityRequest,
  right: NativeReviewAuthorityRequest,
) {
  return (
    left.key === right.key &&
    left.actorId === right.actorId &&
    left.revision === right.revision &&
    left.reviews.length === right.reviews.length &&
    left.reviews.every((review, index) => {
      const candidate = right.reviews[index];
      return (
        candidate?.suggestionId === review.suggestionId &&
        candidate.decisionId === review.decisionId &&
        candidate.action === review.action
      );
    })
  );
}

function assertGrant(
  request: NativeReviewAuthorityRequest,
  grant: NativeReviewAuthorityGrant | false,
) {
  if (
    grant === false ||
    !equalRequest(request, grant) ||
    typeof grant.leaseId !== "string" ||
    grant.leaseId.length === 0 ||
    typeof grant.fenceId !== "string" ||
    grant.fenceId.length === 0 ||
    typeof grant.nonce !== "string" ||
    grant.nonce.length === 0
  ) {
    throw new Error("Native suggestion review authority capability is invalid");
  }
  return grant;
}

export function consumeNativeReviewAuthority(
  binding: NativeSuggestionsBinding,
  capability: unknown,
  request: NativeReviewAuthorityRequest,
) {
  if (typeof capability !== "object" || capability === null) {
    throw new Error(
      "Native suggestion review authority capability is required",
    );
  }
  const testState = testAuthorities.get(capability);
  let grant: NativeReviewAuthorityGrant;
  if (testState) {
    if (testState.status !== "issued") {
      throw new Error(
        `Native suggestion review authority capability is ${testState.status}`,
      );
    }
    testState.status = "consumed";
    grant = Object.freeze({
      ...request,
      leaseId: uuidv4(),
      fenceId: uuidv4(),
      nonce: uuidv4(),
    });
  } else {
    const validator = binding.validateReviewAuthority;
    if (!validator) {
      throw new Error(
        "Native suggestion review authority capability is invalid",
      );
    }
    grant = assertGrant(request, validator(capability, request));
  }
  let nonces = consumedNonces.get(binding);
  if (!nonces) {
    nonces = new Set();
    consumedNonces.set(binding, nonces);
  }
  if (nonces.has(grant.nonce)) {
    throw new Error("Native suggestion review authority capability is reused");
  }
  nonces.add(grant.nonce);
  return grant;
}

export function issueNativeReviewAuthorityForTest() {
  const capability = Object.freeze({});
  testAuthorities.set(capability, { status: "issued" });
  return capability;
}

export function revokeNativeReviewAuthorityForTest(capability: object) {
  const state = testAuthorities.get(capability);
  if (!state || state.status !== "issued") {
    throw new Error("Native suggestion review authority capability is invalid");
  }
  state.status = "revoked";
}

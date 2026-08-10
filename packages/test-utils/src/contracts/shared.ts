export interface BlockNoteContractCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface BlockNoteContractTestApi {
  describe(name: string, run: () => void): void;
  it(name: string, run: () => Promise<void>): void;
}

export function defineBlockNoteContractCases(
  name: string,
  cases: readonly BlockNoteContractCase[],
  test?: BlockNoteContractTestApi,
) {
  const candidate =
    test ??
    (globalThis as { readonly describe?: unknown; readonly it?: unknown });
  if (
    typeof candidate.describe !== "function" ||
    typeof candidate.it !== "function"
  ) {
    throw new Error(
      "BlockNote contract suites require a test API with describe() and it().",
    );
  }
  const api = candidate as BlockNoteContractTestApi;
  api.describe(name, () => {
    for (const contract of cases) {
      api.it(contract.name, contract.run);
    }
  });
}

export function contractCase(
  name: string,
  run: () => Promise<void>,
): BlockNoteContractCase {
  return Object.freeze({
    name,
    async run() {
      try {
        await run();
      } catch (cause) {
        throw new Error(`[BlockNote contract: ${name}] invariant failed.`, {
          cause,
        });
      }
    },
  });
}

export function assertContract(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function sameSerialized(left: unknown, right: unknown) {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return (
      left.byteLength === right.byteLength &&
      left.every((value, index) => value === right[index])
    );
  }
  return Object.is(left, right);
}

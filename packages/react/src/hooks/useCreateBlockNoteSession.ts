"use client";

import type { AnyBlockNoteDocumentDefinition } from "@blocknote/core";
import {
  createBlockNoteSession,
  type BlockNoteSession,
  type BlockNoteSessionOptions,
} from "@blocknote/collaboration";
import { useEffect, useRef, useState } from "react";

export function useCreateBlockNoteSession<
  const Document extends AnyBlockNoteDocumentDefinition,
>(options: BlockNoteSessionOptions<Document>) {
  const generation = useRef(0);
  const [result, setResult] = useState<{
    readonly generation: number;
    readonly options?: BlockNoteSessionOptions<Document>;
    readonly session: BlockNoteSession<Document> | null;
    readonly error: unknown;
  }>({ generation: 0, session: null, error: undefined });

  useEffect(() => {
    const current = ++generation.current;
    let active = true;
    let created: BlockNoteSession<Document> | null = null;
    void createBlockNoteSession(options).then(
      (session) => {
        created = session;
        if (active && generation.current === current) {
          setResult({
            generation: current,
            options,
            session,
            error: undefined,
          });
        } else {
          void session.destroy();
        }
      },
      (error: unknown) => {
        if (active && generation.current === current) {
          setResult({ generation: current, options, session: null, error });
        }
      },
    );
    return () => {
      active = false;
      if (created) {
        void created.destroy();
      }
    };
  }, [options]);

  if (result.options === options && result.error !== undefined) {
    throw result.error;
  }
  return result.options === options ? result.session : null;
}

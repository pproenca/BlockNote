import { expect, expectTypeOf, it, vi } from "vite-plus/test";

import {
  createExtension,
  createStore,
  ExtensionOptions,
} from "./BlockNoteExtension.js";
import { BlockNoteEditor } from "./BlockNoteEditor.js";

const editor = BlockNoteEditor.create();
/**
 * @vitest-environment jsdom
 */
it("creates an extension factory", () => {
  const extension = createExtension(() => {
    return {
      key: "test",
      prosemirrorPlugins: [],
    } as const;
  });

  const extInstance = extension()({ editor });
  expect(extInstance.key).toBe("test");
  expect(extInstance.prosemirrorPlugins).toEqual([]);
});

it("creates an extension factory with options", () => {
  const extension = createExtension((opts: ExtensionOptions<{ x: number }>) => {
    expect(opts.options.x).toBe(1);
    return {
      key: "test",
      prosemirrorPlugins: [],
    } as const;
  });

  const extInstance = extension({ x: 1 })({ editor });
  expect(extInstance.key).toBe("test");
  expect(extInstance.prosemirrorPlugins).toEqual([]);
});

it("creates an extension factory with undefined options", () => {
  const extension = createExtension(
    (opts: ExtensionOptions<{ x: number } | undefined>) => {
      expect(opts.options).toBe(undefined);
      return {
        key: "test",
        prosemirrorPlugins: [],
      } as const;
    },
  );

  const extInstance = extension()({ editor });
  expect(extInstance.key).toBe("test");
  expect(extInstance.prosemirrorPlugins).toEqual([]);
});

it("creates an extension factory from an object", () => {
  const extension = createExtension({
    key: "test",
    prosemirrorPlugins: [],
  } as const);

  const extInstance = extension({ editor });
  expect(extInstance.key).toBe("test");
  expect(extInstance.prosemirrorPlugins).toEqual([]);
});

it("allows arbitrary properties on a no-options extension", () => {
  const extension = createExtension(() => {
    return {
      key: "test",
      prosemirrorPlugins: [],
      arbitraryProperty: "arbitraryValue",
      arbitraryMethod: () => {
        return "arbitraryValue";
      },
    } as const;
  });

  const extInstance = extension()({ editor });
  expect(extInstance.arbitraryProperty).toBe("arbitraryValue");
  expect(extInstance.arbitraryMethod()).toBe("arbitraryValue");
  // @ts-expect-error - this method takes no arguments
  extInstance.arbitraryMethod(90);
  // @ts-expect-error - this property is not defined
  extInstance.nonExistentProperty = "newArbitraryValue";
});

it("allows arbitrary properties on an extension with options", () => {
  const extension = createExtension((opts: ExtensionOptions<{ x: number }>) => {
    expect(opts.options.x).toBe(1);
    return {
      key: "test",
      prosemirrorPlugins: [],
      arbitraryProperty: "arbitraryValue",
      arbitraryMethod: () => {
        return "arbitraryValue";
      },
    } as const;
  });

  const extInstance = extension({ x: 1 })({ editor });
  expect(extInstance.arbitraryProperty).toBe("arbitraryValue");
  // @ts-expect-error - this method takes no arguments
  extInstance.arbitraryMethod(90);
  // @ts-expect-error - this property is not defined
  extInstance.nonExistentProperty = "newArbitraryValue";
});

it("creates immutable semantic extension configuration", () => {
  const SemanticExtension = createExtension(
    ({ options }: ExtensionOptions<{ label: string }>) => ({
      key: "semantic",
      label: options.label,
    }),
    {
      name: "semantic",
      version: "1",
      dependencies: ["dependency"] as const,
    },
  );
  const options = { label: "configured" };
  const configured = SemanticExtension(options);
  options.label = "mutated";

  expectTypeOf(configured.name).toEqualTypeOf<"semantic">();
  expectTypeOf(configured.dependencies).toEqualTypeOf<
    readonly ["dependency"]
  >();
  expect(configured.options).toEqual({ label: "configured" });
  expect(Object.isFrozen(configured.options)).toBe(true);
  expect(Object.isFrozen(configured.dependencies)).toBe(true);

  const checkOpaqueConfiguration = () => {
    // @ts-expect-error BlockNote owns instantiation of semantic extensions
    configured({ editor });
  };
  expectTypeOf(checkOpaqueConfiguration).toBeFunction();
});

it("supports TanStack React Store 0.7 and 0.11 consumers", () => {
  const store = createStore({ count: 0 });
  const listener = vi.fn();
  const stop = store.subscribe(listener);

  expect(store.get()).toEqual({ count: 0 });
  expect(stop.unsubscribe).toBe(stop);

  store.setState({ count: 1 });
  expect(listener).toHaveBeenCalled();

  stop();
});

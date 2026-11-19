import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as ReactQuery from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

/**
 * Pins `patches/@tanstack__react-query@5.101.0.patch`. A server render never mutates and never
 * re-renders, so on the server `useMutation` returns the idle result a fresh `MutationObserver`
 * reports instead of building one (plus its subscription and callbacks). The client's first render
 * reads the same idle result from its real observer, so hydration matches.
 *
 * The unit project runs in node, so `typeof window === 'undefined'` and the server branch is the
 * one under test. (`.test.ts`, not `.tsx`: the unit project only collects `.test.ts` under `src/`.)
 *
 * 🔴 If this file fails after a react-query upgrade, re-read `useMutation` and
 * `MutationObserver#updateResult` in the new build, regenerate the patch (the idle literal must
 * match the new observer's initial result, key order included) or drop it, and update
 * `package.json` → `pnpm.patchedDependencies`.
 */

const requireHere = createRequire(import.meta.url);
const pkgDir = path.dirname(requireHere.resolve('@tanstack/react-query/package.json'));

// Three ways the package reaches a render: the Vite-optimised copy this config pre-bundles, the
// native ESM entry (what `@trpc/react-query` imports — see trpc-ssr-query-gc.test.ts), and the
// CommonJS entry. The patch edits both build files; each instance is tested with its own
// QueryClient, since each has its own React context.
const builds: Array<[string, () => Promise<typeof ReactQuery>]> = [
  ['pre-bundled', () => import('@tanstack/react-query')],
  [
    'native ESM',
    () => import(/* @vite-ignore */ pathToFileURL(path.join(pkgDir, 'build/modern/index.js')).href),
  ],
  ['CommonJS', async () => requireHere(path.join(pkgDir, 'build/modern/index.cjs'))],
];

type MutationResult = ReactQuery.UseMutationResult<number, Error, number>;

function renderCapturing(rq: typeof ReactQuery, client: ReactQuery.QueryClient, calls = 1) {
  const results: MutationResult[] = [];
  const mutationFn = vi.fn(async (n: number): Promise<number> => n * 2);
  function Probe() {
    for (let i = 0; i < calls; i++) results.push(rq.useMutation({ mutationFn }));
    return createElement('i', null, results[0].status);
  }
  const html = renderToString(
    createElement(rq.QueryClientProvider, { client }, createElement(Probe))
  );
  return { html, results, mutationFn };
}

describe.each(builds)('useMutation during a server render (%s build)', (_name, load) => {
  it('constructs no MutationObserver', async () => {
    const rq = await load();
    const client = new rq.QueryClient();
    // Every MutationObserver constructor calls client.defaultMutationOptions (via setOptions).
    const defaults = vi.spyOn(client, 'defaultMutationOptions');

    const { html } = renderCapturing(rq, client, 3);
    expect(html).toBe('<i>idle</i>');
    expect(defaults).not.toHaveBeenCalled();

    // Positive control: the instrument does see an observer being built.
    new rq.MutationObserver(client, { mutationFn: async () => 1 });
    expect(defaults).toHaveBeenCalledTimes(1);
  });

  // The stub must use the same "is this the server?" answer as react-query's own hooks
  // (useBaseQuery reads `environmentManager.isServer()`), not the fixed `isServer` constant, so an
  // app that overrides it via `environmentManager.setIsServer` gets queries and mutations that agree.
  it('follows environmentManager.setIsServer, like useBaseQuery', async () => {
    const rq = await load();
    const client = new rq.QueryClient();
    const defaults = vi.spyOn(client, 'defaultMutationOptions');
    try {
      rq.environmentManager.setIsServer(() => false);
      const { html } = renderCapturing(rq, client);
      expect(html).toBe('<i>idle</i>');
      // Not the server, so the real hook ran and built its MutationObserver.
      expect(defaults).toHaveBeenCalledTimes(1);

      defaults.mockClear();
      rq.environmentManager.setIsServer(() => true);
      renderCapturing(rq, client);
      expect(defaults).not.toHaveBeenCalled();
    } finally {
      rq.environmentManager.setIsServer(() => rq.isServer);
    }
  });

  // Hydration parity. Invariant guard rather than regression coverage: before the patch the
  // server read a real observer's result, so this held then too. It is what keeps the hand-written
  // idle literal in the patch honest against the library's own initial result.
  it('returns exactly the idle result a fresh observer reports, in the same key order', async () => {
    const rq = await load();
    const client = new rq.QueryClient();
    const { results } = renderCapturing(rq, client);
    const stub = results[0] as unknown as Record<string, unknown>;

    const observerResult = new rq.MutationObserver(client, {
      mutationFn: async () => 1,
    }).getCurrentResult();
    // What the unpatched hook returns: `{ ...result, mutate, mutateAsync: result.mutate }`.
    const reference: Record<string, unknown> = {
      ...observerResult,
      mutate: () => undefined,
      mutateAsync: observerResult.mutate,
    };

    expect(Object.keys(stub)).toEqual(Object.keys(reference));
    for (const key of Object.keys(reference)) {
      if (typeof reference[key] === 'function') {
        expect(typeof stub[key], key).toBe('function');
      } else {
        expect(Object.is(stub[key], reference[key]), key).toBe(true);
      }
    }
    expect(stub.status).toBe('idle');
    expect(stub.isIdle).toBe(true);
  });

  it('hands every hook call its own result object', async () => {
    // @trpc/react-query assigns `.trpc` onto the object useMutation returns, so a shared
    // object would carry one call site's metadata into another's.
    const rq = await load();
    const { results } = renderCapturing(rq, new rq.QueryClient(), 2);
    expect(results[0]).not.toBe(results[1]);
  });

  it('still runs a real mutation if mutateAsync/mutate is called during the render', async () => {
    const rq = await load();
    const { results, mutationFn } = renderCapturing(rq, new rq.QueryClient());
    await expect(results[0].mutateAsync(21)).resolves.toBe(42);
    results[0].mutate(1);
    await vi.waitFor(() => expect(mutationFn).toHaveBeenCalledTimes(2));
  });

  it('still throws without a QueryClientProvider', async () => {
    const rq = await load();
    function Orphan() {
      rq.useMutation({ mutationFn: async () => 1 });
      return null;
    }
    expect(() => renderToString(createElement(Orphan))).toThrow(/No QueryClient set/);
  });
});

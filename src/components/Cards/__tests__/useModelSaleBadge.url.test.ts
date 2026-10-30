// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useModelSaleBadge } from '~/components/Cards/ModelCardContext';
import { queryClient, trpc } from '~/utils/trpc';

/**
 * 🔴 AN ANONYMOUS CARD'S REQUEST URL MUST NOT CHANGE. Anonymous `getActiveSales` responses are
 * shared-cacheable and the cache is keyed by the exact URL, so a request that encodes the same input
 * differently — another procedure path, another transformer, an extra field, another id order — is a
 * cold cache across the deploy, for every popular model at once.
 *
 * This runs the REAL tRPC clients (nothing in `~/utils/trpc` is mocked) with only `fetch` stubbed,
 * and compares two things:
 *  - the pre-change hook's call, verbatim: `trpc.model.getActiveSales.useQuery({ ids: [id] })` through
 *    the React client;
 *  - `useModelSaleBadge`, which resolves an anonymous card through the vanilla client.
 * Both must produce the SAME list of URLs, and that list must equal a pinned literal — the literal is
 * what stops "both changed the same way" from passing.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const urls: string[] = [];

function stubFetch() {
  urls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(typeof input === 'string' ? input : input.toString());
      return new Response(JSON.stringify({ result: { data: { json: {} } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
}

async function renderUnderTrpc(Inner: ComponentType) {
  // Both renders share the React client's browser QueryClient singleton; without a clear, the second
  // render of an identical query key is served from cache and sends nothing.
  queryClient.clear();
  const Wrapped = trpc.withTRPC(Inner as never) as unknown as ComponentType<{ pageProps: object }>;
  const root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(createElement(Wrapped, { pageProps: {} }));
  });
  // Real timers, and longer than the signed-in batch window: the anonymous path schedules nothing,
  // but a regression that batched anonymous cards must get to send its merged URL and be seen.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
  });
  root.unmount();
}

const IDS = [907, 41];

function PreChangeCard({ id }: { id: number }) {
  // origin/main's `useModelSaleBadge` body, verbatim.
  trpc.model.getActiveSales.useQuery({ ids: [id] }, { enabled: true, staleTime: 60_000 });
  return null;
}

function Card({ id }: { id: number }) {
  useModelSaleBadge(id, false);
  return null;
}

function row(C: ComponentType<{ id: number }>) {
  return function Row() {
    return createElement(Fragment, null, ...IDS.map((id) => createElement(C, { id, key: id })));
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.isAuthed = undefined;
});

describe('an anonymous provider-less card sends the URL it always sent', () => {
  it('matches the pre-change hook byte for byte, and the pinned literal', async () => {
    window.isAuthed = false;

    stubFetch();
    await renderUnderTrpc(row(PreChangeCard));
    const before = [...urls].sort();

    stubFetch();
    await renderUnderTrpc(row(Card));
    const after = [...urls].sort();

    // POSITIVE CONTROL: the instrument saw the requests at all — two empty lists are also equal.
    expect(before).toHaveLength(IDS.length);
    expect(after).toEqual(before);
    expect(after).toEqual([
      '/api/trpc/model.getActiveSales?input=%7B%22json%22%3A%7B%22ids%22%3A%5B41%5D%7D%7D',
      '/api/trpc/model.getActiveSales?input=%7B%22json%22%3A%7B%22ids%22%3A%5B907%5D%7D%7D',
    ]);
  });
});

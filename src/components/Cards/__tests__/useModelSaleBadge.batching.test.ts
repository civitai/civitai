// @vitest-environment happy-dom
import type { QueryClient as QueryClientType } from '@tanstack/react-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import {
  MODEL_SALE_IDS_PER_REQUEST,
  getActiveSalesSchema,
} from '~/server/schema/model-sale.schema';

/**
 * 🔴 THE DEFECT: a model card rendered outside a sale provider (home blocks, collections, related
 * models) asked `model.getActiveSales` for its OWN id, so a row of N such cards was N requests of one
 * id each. For a SIGNED-IN browser the fix coalesces them, so the assertion that matters there is
 * "N cards → one request carrying N ids".
 *
 * 🔴 AND THE OPPOSITE FOR AN ANONYMOUS BROWSER. An anonymous response is shared-cacheable by its exact
 * URL, so a single-id request for a popular model is a cache hit; a merged URL almost never is. An
 * anonymous row must therefore stay N requests of exactly `{ ids: [id] }`.
 *
 * 🔴 THE RECORDER TAKES BOTH ENTRY POINTS ON PURPOSE. The pre-change hook called
 * `trpc.model.getActiveSales.useQuery({ ids: [id] })` per card; the fixed one goes through the vanilla
 * client. Recording both into one list is what makes old code red for the RIGHT reason — the
 * request shape — rather than dying on a missing mock.
 *
 * Timers are FAKE, so "the window has passed" is an exact clock position rather than a real sleep
 * racing the window — which is also what lets the window's length itself be pinned below.
 */
const recorded = vi.hoisted(() => {
  const requests: number[][] = [];
  /** Ids that are on sale; every other id comes back without an entry, as the server returns it. */
  const onSale = new Map<number, Date | string>();
  let failNext = false;
  const salesFor = (ids: number[]) =>
    Object.fromEntries(
      ids
        .filter((id) => onSale.has(id))
        .map((id) => [id, { endsAt: onSale.get(id), discountType: 'Percent', discountAmount: 25 }])
    );
  return {
    requests,
    onSale,
    failOnce() {
      failNext = true;
    },
    reset() {
      requests.length = 0;
      onSale.clear();
      failNext = false;
    },
    // Pre-change entry point: a per-card hook query.
    useQuery: (input: { ids: number[] }, opts?: { enabled?: boolean }) => {
      if (opts?.enabled === false) return { data: undefined };
      requests.push(input.ids);
      return { data: salesFor(input.ids) };
    },
    // Post-change entry point: the vanilla client.
    query: async (input: { ids: number[] }) => {
      requests.push(input.ids);
      if (failNext) {
        failNext = false;
        throw new Error('boom');
      }
      return salesFor(input.ids);
    },
  };
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({ 'model.getActiveSales': { useQuery: recorded.useQuery } }),
  trpcVanilla: { model: { getActiveSales: { query: recorded.query } } },
}));

import * as CardContext from '~/components/Cards/ModelCardContext';
const { useModelSaleBadge } = CardContext;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUNNING = new Date('2999-01-01T00:00:00.000Z');
/**
 * The batch window, as a LITERAL rather than the exported constant: the window-length test pins the
 * value, and an expectation read off the implementation would follow a mutated constant.
 */
const WINDOW_MS = 50;
/** Comfortably past the window, so settle points do not sit on its boundary. */
const SETTLE_MS = 3 * WINDOW_MS;

/** Moves the fake clock and lets React and React Query apply what resolved. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

type Rendered = { results: Map<number, unknown>; client: QueryClientType };

/**
 * Renders one probe per id, all under one QueryClient — a row of provider-less cards. Returns the
 * QueryClient too, so a test can read each card's query STATE, not just the badge it rendered.
 */
async function mountCards(
  ids: number[],
  { skip = false, signedIn }: { skip?: boolean; signedIn: boolean }
): Promise<Rendered> {
  window.isAuthed = signedIn;
  const results = new Map<number, unknown>();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(document.createElement('div'));
  function Card({ id }: { id: number }) {
    results.set(id, useModelSaleBadge(id, skip));
    return null;
  }
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          Fragment,
          null,
          ...ids.map((id, i) => createElement(Card, { id, key: `${id}-${i}` }))
        )
      )
    );
  });
  return { results, client };
}

async function renderCards(ids: number[], opts: { skip?: boolean; signedIn: boolean }) {
  const rendered = await mountCards(ids, opts);
  await advance(SETTLE_MS);
  return rendered;
}

const statuses = (client: QueryClientType) =>
  client
    .getQueryCache()
    .getAll()
    .map((q) => q.state.status);

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

beforeEach(() => {
  vi.useFakeTimers();
  recorded.reset();
  (CardContext as { __resetModelSaleBatcher?: () => void }).__resetModelSaleBatcher?.();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.isAuthed = undefined;
});

describe('useModelSaleBadge — provider-less cards, signed in', () => {
  it('asks once for a whole row of cards, not once per card', async () => {
    // Descending and non-contiguous, so no derivation from the fixture can coincide by accident.
    const ids = [907, 803, 701, 609, 502, 411, 307, 203, 109, 41, 17, 3];

    await renderCards(ids, { signedIn: true });

    expect(recorded.requests).toHaveLength(1);
    expect(sorted(recorded.requests[0])).toEqual(sorted(ids));
  });

  it('waits exactly the batch window before asking', async () => {
    await mountCards([907, 41], { signedIn: true });

    await advance(WINDOW_MS - 1);
    expect(recorded.requests).toHaveLength(0);

    await advance(1);
    expect(recorded.requests).toHaveLength(1);
  });

  it('asks for a model once when two cards show it', async () => {
    await renderCards([7, 8, 7], { signedIn: true });

    expect(recorded.requests).toHaveLength(1);
    expect(sorted(recorded.requests[0])).toEqual([7, 8]);
  });

  it('splits a surface larger than one chunk into requests the procedure accepts', async () => {
    // Past the procedure's own cap (so a mutant that stops chunking is REJECTED by the schema, not
    // just mis-counted), and not a multiple of the chunk, so a trailing partial chunk exists.
    const count = 1201;
    const ids = Array.from({ length: count }, (_, i) => 900000 - i * 7);

    await renderCards(ids, { signedIn: true });

    // Schema first: it is the assertion a no-chunking mutant must fail.
    for (const request of recorded.requests) {
      expect(getActiveSalesSchema.safeParse({ ids: request }).success).toBe(true);
    }
    for (const request of recorded.requests) {
      expect(request.length).toBeLessThanOrEqual(MODEL_SALE_IDS_PER_REQUEST);
    }
    expect(recorded.requests).toHaveLength(Math.ceil(count / MODEL_SALE_IDS_PER_REQUEST));
    expect(new Set(recorded.requests.flat()).size).toBe(count);
  });

  it('gives each card its own model’s sale and nothing to a card without one', async () => {
    recorded.onSale.set(8, RUNNING);

    const { results } = await renderCards([7, 8, 9], { signedIn: true });

    expect(results.get(8)).toMatchObject({ discountType: 'Percent', discountAmount: 25 });
    expect(results.get(7)).toBeUndefined();
    expect(results.get(9)).toBeUndefined();
  });

  it('drops a sale whose window has already closed (ISO string from the wire)', async () => {
    recorded.onSale.set(7, '2000-01-01T00:00:00.000Z');

    const { results } = await renderCards([7], { signedIn: true });

    expect(results.get(7)).toBeUndefined();
  });

  it('asks nothing when a provider owns the lookup', async () => {
    await renderCards([7, 8], { skip: true, signedIn: true });

    expect(recorded.requests).toEqual([]);
  });

  it('CONTROL for the failure case: the same row without a failure shows the badge', async () => {
    recorded.onSale.set(7, RUNNING);

    const { results, client } = await renderCards([7, 8], { signedIn: true });

    expect(recorded.requests).toHaveLength(1);
    expect(results.get(7)).toMatchObject({ discountType: 'Percent' });
    expect(statuses(client)).toEqual(['success', 'success']);
  });

  it('settles every waiting card into an error, with no badge, when the request fails', async () => {
    recorded.onSale.set(7, RUNNING);
    recorded.failOnce();

    const { results, client } = await renderCards([7, 8], { signedIn: true });

    expect(recorded.requests).toHaveLength(1);
    expect(results.get(7)).toBeUndefined();
    // Settled, not merely un-answered: a waiter the batcher forgot to reject would sit `pending`
    // forever, and render no badge exactly as a handled failure does.
    expect(statuses(client)).toEqual(['error', 'error']);
  });

  it('settles every card, across chunks, when the fetch throws synchronously', async () => {
    // Three chunks: a throw that escaped the loop would strand the first chunk AND the later ones.
    const ids = Array.from({ length: MODEL_SALE_IDS_PER_REQUEST * 2 + 13 }, (_, i) => 50000 + i);
    vi.spyOn(CardContext.modelSaleBatcher, 'fetch').mockImplementation(() => {
      throw new Error('sync boom');
    });

    const { client } = await mountCards(ids, { signedIn: true });
    let escaped: unknown;
    try {
      await advance(SETTLE_MS);
    } catch (error) {
      escaped = error;
    }

    const all = statuses(client);
    expect(all).toHaveLength(ids.length);
    expect(all.filter((s) => s !== 'error')).toEqual([]);
    expect(escaped).toBeUndefined();
  });

  it('fails only the chunk whose request failed; every other chunk still gets its sales', async () => {
    // Three chunks, the last one partial, and every id on sale — so a card that wrongly settles
    // `error` also visibly loses a badge it should have had.
    const ids = Array.from(
      { length: MODEL_SALE_IDS_PER_REQUEST * 2 + 37 },
      (_, i) => 70000 + i * 3
    );
    for (const id of ids) recorded.onSale.set(id, RUNNING);
    // 🔴 ORDERING IS THE POINT. The first chunk rejects at once; the others answer only after a
    // further timer tick. A promise settles once, so if the later chunks resolved FIRST, a reject
    // that fanned out to every card in the flush would hit already-settled promises and be
    // invisible. Rejecting first is the ordering in which a too-wide reject actually lands.
    const calls: number[][] = [];
    vi.spyOn(CardContext.modelSaleBatcher, 'fetch').mockImplementation((chunk: number[]) => {
      calls.push(chunk);
      if (calls.length === 1) return Promise.reject(new Error('chunk boom'));
      return new Promise((resolve) => {
        setTimeout(() => resolve(recorded.query({ ids: chunk }) as never), 10);
      });
    });

    const { results, client } = await renderCards(ids, { signedIn: true });

    expect(calls).toHaveLength(3);
    const failed = new Set(calls[0]);
    // Non-vacuous on both sides: a full chunk failed, and the rest of the surface is not empty.
    expect(failed.size).toBe(MODEL_SALE_IDS_PER_REQUEST);
    const rest = ids.filter((id) => !failed.has(id));
    expect(rest).toHaveLength(ids.length - MODEL_SALE_IDS_PER_REQUEST);

    const stateOf = (id: number) =>
      client.getQueryState(['model.getActiveSales.byModel', id])?.status;
    expect([...failed].filter((id) => stateOf(id) !== 'error')).toEqual([]);
    expect(rest.filter((id) => stateOf(id) !== 'success')).toEqual([]);
    expect(rest.filter((id) => !results.get(id))).toEqual([]);
    for (const id of failed) expect(results.get(id)).toBeUndefined();
  });
});

describe('useModelSaleBadge — provider-less cards, anonymous', () => {
  it('keeps one request per card, each for exactly that card’s id', async () => {
    const ids = [907, 803, 701, 609, 41];

    await renderCards(ids, { signedIn: false });

    expect(recorded.requests).toHaveLength(ids.length);
    for (const request of recorded.requests) expect(request).toHaveLength(1);
    expect(sorted(recorded.requests.flat())).toEqual(sorted(ids));
  });

  it('still asks once for a model shown by two cards', async () => {
    await renderCards([7, 8, 7], { signedIn: false });

    expect(sorted(recorded.requests.map((r) => r[0]))).toEqual([7, 8]);
    for (const request of recorded.requests) expect(request).toHaveLength(1);
  });

  it('gives each card its own model’s sale', async () => {
    recorded.onSale.set(8, RUNNING);

    const { results } = await renderCards([7, 8], { signedIn: false });

    expect(results.get(8)).toMatchObject({ discountType: 'Percent', discountAmount: 25 });
    expect(results.get(7)).toBeUndefined();
  });
});

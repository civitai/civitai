// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import {
  MODEL_SALE_IDS_PER_REQUEST,
  getActiveSalesSchema,
} from '~/server/schema/model-sale.schema';

/**
 * 🔴 THE DEFECT: a model card rendered outside a sale provider (home blocks, collections, related
 * models) asked `model.getActiveSales` for its OWN id, so a row of N such cards was N requests of one
 * id each. The fix coalesces them, so the assertion that matters is "N cards → one request carrying
 * N ids".
 *
 * 🔴 THE RECORDER TAKES BOTH ENTRY POINTS ON PURPOSE. The pre-change hook called
 * `trpc.model.getActiveSales.useQuery({ ids: [id] })` per card; the fixed one goes through the vanilla
 * client. Recording both into one list is what makes the old code red for the RIGHT reason — N
 * single-id requests — rather than dying on a missing mock.
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
    // Post-change entry point: the vanilla client the batcher flushes through.
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
/** Longer than the batch window, as a literal so the pre-change module (which has no constant) runs too. */
const SETTLE_MS = 150;

/** Renders one probe per id, all under one QueryClient — a row of provider-less cards. */
async function renderCards(ids: number[], skip = false) {
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
  await act(async () => {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  });
  return results;
}

beforeEach(() => {
  recorded.reset();
  (CardContext as { __resetModelSaleBatcher?: () => void }).__resetModelSaleBatcher?.();
});

describe('useModelSaleBadge — provider-less cards', () => {
  it('asks once for a whole row of cards, not once per card', async () => {
    // Descending and non-contiguous, so no derivation from the fixture can coincide by accident.
    const ids = [907, 803, 701, 609, 502, 411, 307, 203, 109, 41, 17, 3];

    await renderCards(ids);

    expect(recorded.requests).toHaveLength(1);
    expect([...recorded.requests[0]].sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
  });

  it('asks for a model once when two cards show it', async () => {
    await renderCards([7, 8, 7]);

    expect(recorded.requests).toHaveLength(1);
    expect([...recorded.requests[0]].sort((a, b) => a - b)).toEqual([7, 8]);
  });

  it('splits a surface larger than one chunk into requests the procedure accepts', async () => {
    // Over two chunks, and not a multiple of the chunk, so a trailing partial chunk exists.
    const count = MODEL_SALE_IDS_PER_REQUEST * 2 + 37;
    const ids = Array.from({ length: count }, (_, i) => 900000 - i * 7);

    await renderCards(ids);

    expect(recorded.requests).toHaveLength(3);
    for (const request of recorded.requests) {
      expect(request.length).toBeLessThanOrEqual(MODEL_SALE_IDS_PER_REQUEST);
      expect(getActiveSalesSchema.safeParse({ ids: request }).success).toBe(true);
    }
    expect(new Set(recorded.requests.flat()).size).toBe(count);
  });

  it('gives each card its own model’s sale and nothing to a card without one', async () => {
    recorded.onSale.set(8, RUNNING);

    const results = await renderCards([7, 8, 9]);

    expect(results.get(8)).toMatchObject({ discountType: 'Percent', discountAmount: 25 });
    expect(results.get(7)).toBeUndefined();
    expect(results.get(9)).toBeUndefined();
  });

  it('drops a sale whose window has already closed (ISO string from the wire)', async () => {
    recorded.onSale.set(7, '2000-01-01T00:00:00.000Z');

    const results = await renderCards([7]);

    expect(results.get(7)).toBeUndefined();
  });

  it('asks nothing when a provider owns the lookup', async () => {
    await renderCards([7, 8], true);

    expect(recorded.requests).toEqual([]);
  });

  it('shows no badge, and does not throw, when the request fails', async () => {
    recorded.onSale.set(7, RUNNING);
    recorded.failOnce();

    const results = await renderCards([7, 8]);

    expect(results.get(7)).toBeUndefined();
  });
});

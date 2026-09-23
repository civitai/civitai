import React, { useEffect, useMemo } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { useInfiniteQuery } from '@tanstack/react-query';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

import type * as CollectionUtils from '~/components/Collections/collection.utils';
import { countPendingReviewItems } from '~/components/Collections/collection-review-counts';
import { ModerationControls } from '~/pages/collections/[collectionId]/review';
import type { CollectionItemExpanded } from '~/server/services/collection.service';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';
import type * as TrpcModule from '~/utils/trpc';

/**
 * Guards WHERE the pending-review count is taken, which the helper's own unit tests cannot reach.
 *
 * `countPendingReviewItems` has to run in `onMutate`. React Query pushes the latest render's options
 * into an in-flight mutation (`MutationObserver.setOptions` → `mutation.setOptions`), and the
 * optimistic `setInfiniteData` in `onMutate` rewrites the very query `collectionItems` is derived
 * from — so an `onSuccess` closure sees the POST-mutation list, matches nothing, and decrements the
 * badge by 0. That shipped once (bca7d01ebb) and was caught in review, not by a test.
 *
 * The mutation resolves on a timer so a re-render lands between `onMutate` and `onSuccess`. Without
 * that gap the broken form passes too — a `mutationFn` settling in a microtask beats React's commit
 * — so the test asserts the gap actually opened rather than trusting it.
 */

/** Every row the fixture renders; two are pending review, one was already decided. */
const ITEMS = [
  { id: 1, status: CollectionItemStatus.REVIEW },
  { id: 2, status: CollectionItemStatus.REVIEW },
  { id: 3, status: CollectionItemStatus.ACCEPTED },
] as unknown as CollectionItemExpanded[];

const ITEM_IDS = ITEMS.map((x) => x.id);
const EXPECTED_REVIEWED = 2;

const filters = {
  collectionId: 7,
  // Both chips on, as a contest queue runs: an ACCEPTED row stays visible after the write, so the
  // list is rewritten in place rather than emptied. `reviewed` then differs from both the row count
  // and the selection size, so a wrong answer cannot coincide with the right one.
  statuses: [CollectionItemStatus.REVIEW, CollectionItemStatus.ACCEPTED],
  forReview: true,
};

type LogEntry = { kind: 'render'; pending: number } | { kind: 'reviewed'; reviewed: number };

const shared = vi.hoisted(() => ({
  log: [] as { kind: string; pending?: number; reviewed?: number }[],
  queryKey: ['test.collection.getAllCollectionItems'] as const,
  /** Long enough to clear React's commit, short enough that a wedged test still reports. */
  delayMs: 50,
}));

vi.mock('~/components/Collections/collection.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionUtils>()),
  useOnCollectionItemsReviewed: () => (args: { collectionId: number; reviewed: number }) => {
    shared.log.push({ kind: 'reviewed', reviewed: args.reviewed });
  },
}));

/**
 * `~/utils/trpc` stands in for the router, but the parts the regression lives in are real: the
 * mutation is React Query's own `useMutation`, and the `getAllCollectionItems` utils read and write
 * the same `QueryClient` the harness below subscribes to. Everything else resolves to an inert
 * no-op, so an unlisted procedure cannot crash the render — nor satisfy an assertion.
 */
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { useMutation, useQueryClient } = await import('@tanstack/react-query');
  const { CollectionType } = await import('~/shared/utils/prisma/enums');

  const noop = async () => undefined;
  const inertUtilsProc = () => ({
    invalidate: noop,
    refetch: noop,
    cancel: noop,
    reset: noop,
    setData: () => undefined,
    getData: () => undefined,
    setInfiniteData: () => undefined,
    getInfiniteData: () => undefined,
  });

  const useUtils = () => {
    const queryClient = useQueryClient();
    const collectionItemsUtils = {
      cancel: async () => queryClient.cancelQueries({ queryKey: shared.queryKey }),
      invalidate: async () => queryClient.invalidateQueries({ queryKey: shared.queryKey }),
      getInfiniteData: () => queryClient.getQueryData(shared.queryKey),
      setInfiniteData: (_input: unknown, updater: unknown) =>
        queryClient.setQueryData(shared.queryKey, updater as never),
    };
    return new Proxy({} as Record<string, unknown>, {
      get: (_target, router) =>
        typeof router !== 'string'
          ? undefined
          : new Proxy({} as Record<string, unknown>, {
              get: (_t, proc) => {
                if (typeof proc !== 'string') return undefined;
                return router === 'collection' && proc === 'getAllCollectionItems'
                  ? collectionItemsUtils
                  : inertUtilsProc();
              },
            }),
    });
  };

  const updateCollectionItemsStatus = {
    useMutation: (opts: Record<string, unknown>) =>
      useMutation({
        mutationFn: async () => {
          await new Promise((resolve) => setTimeout(resolve, shared.delayMs));
          return { type: CollectionType.Image };
        },
        ...opts,
      }),
  };

  const inertProc = () => ({
    useQuery: () => ({ data: undefined, isLoading: false, isFetching: false }),
    useInfiniteQuery: () => ({ data: undefined, isLoading: false, isFetching: false }),
    useMutation: () => ({ mutate: () => undefined, mutateAsync: noop, isPending: false }),
  });

  const trpc = new Proxy(
    { useUtils, collection: { updateCollectionItemsStatus } } as Record<string, unknown>,
    {
      get: (target, key) => {
        if (typeof key !== 'string') return undefined;
        if (key in target) return target[key];
        return new Proxy({} as Record<string, unknown>, {
          get: (_t, proc) => (typeof proc === 'string' ? inertProc() : undefined),
        });
      },
    }
  );

  return { ...(await importOriginal<typeof TrpcModule>()), trpc };
});

const firstPage = () => ({ collectionItems: ITEMS, nextCursor: undefined });

/**
 * Stands in for the review page's own wiring: one `getAllCollectionItems` subscription, with
 * `collectionItems` memoized over its pages. That memo is what lets the mutation rewrite its own
 * input prop underneath itself — reproduce it or there is no race to catch.
 */
function Harness() {
  const { data } = useInfiniteQuery({
    queryKey: shared.queryKey,
    queryFn: async () => firstPage(),
    initialPageParam: null as number | null,
    getNextPageParam: () => undefined,
    initialData: { pages: [firstPage()], pageParams: [null] },
    staleTime: Infinity,
  });

  const collectionItems = useMemo(
    () => data?.pages.flatMap((x) => x.collectionItems) ?? [],
    [data?.pages]
  );

  useEffect(() => {
    shared.log.push({
      kind: 'render',
      pending: countPendingReviewItems(collectionItems, ITEM_IDS),
    });
  }, [collectionItems]);

  return <ModerationControls collectionItems={collectionItems} filters={filters} />;
}

/** The toolbar's icon buttons carry no accessible name, so address them by their glyph. */
function iconButton(glyph: string) {
  const button = document.querySelector(`.tabler-icon-${glyph}`)?.closest('button');
  if (!button) throw new Error(`no button carrying .tabler-icon-${glyph}`);
  return button;
}

describe('collection review pending-review decrement', () => {
  test('reports the count taken before the optimistic update, not after it', async () => {
    renderWithProviders(<Harness />);

    await vi.waitFor(() =>
      expect(shared.log.at(-1)).toEqual({ kind: 'render', pending: EXPECTED_REVIEWED })
    );

    await userEvent.click(iconButton('square-check')); // Select all
    await userEvent.click(iconButton('check')); // Accept
    await userEvent.click(page.getByRole('button', { name: 'Yes' }).element());

    await vi.waitFor(() => expect(shared.log.some((e) => e.kind === 'reviewed')).toBe(true));

    const log = shared.log as LogEntry[];
    const reviewedAt = log.findIndex((e) => e.kind === 'reviewed');

    // The window this test depends on: the optimistic rewrite re-rendered the harness with a list
    // that has nothing left to count, and it did so BEFORE onSuccess ran. Fails first, and loudly,
    // if the timing it relies on ever stops happening.
    expect(log.slice(0, reviewedAt).some((e) => e.kind === 'render' && e.pending === 0)).toBe(true);

    expect(log[reviewedAt]).toEqual({ kind: 'reviewed', reviewed: EXPECTED_REVIEWED });
  });
});

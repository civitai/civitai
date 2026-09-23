import { describe, expect, it, vi, beforeEach } from 'vitest';

import type * as ModelService from '~/server/services/model.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

const { getModelsWithImagesAndModelVersions } = vi.hoisted(() => ({
  getModelsWithImagesAndModelVersions: vi.fn(),
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModelsWithImagesAndModelVersions,
}));

import { getModelsInfiniteHandler } from '~/server/controllers/model.controller';

/**
 * `/tag/:name` advertises "N models tagged X" in its meta description and its
 * CollectionPage schema, then renders whatever the period filter returns. The default
 * period is Month, so a tag whose models all shipped earlier renders an empty grid
 * under a promise of content — which Google reports as a soft 404 and a visitor reads
 * as a broken page.
 *
 * `periodFallback` retries the FIRST page at AllTime. Every guard below is load-bearing:
 * without the opt-in it would change the browse feed, and without the cursor check a
 * reader who pages to the end of a tag would be silently thrown back to page one of a
 * different result set.
 */

const ITEM = { id: 1 } as never;

function ctx() {
  return { user: undefined, cache: { canCache: true }, req: {}, features: {} };
}

function run(input: Record<string, unknown>) {
  return getModelsInfiniteHandler({
    input: { limit: 10, period: MetricTimeframe.Month, ...input },
    ctx: ctx(),
  } as never);
}

/** Pages returned in order; each call takes the next one. */
function respondWith(...pages: { items: unknown[]; nextCursor?: unknown }[]) {
  getModelsWithImagesAndModelVersions.mockReset();
  for (const page of pages) getModelsWithImagesAndModelVersions.mockResolvedValueOnce(page);
  // Anything past the scripted pages is an empty terminal page, so a runaway loop
  // ends as a failed assertion rather than hanging the runner.
  getModelsWithImagesAndModelVersions.mockResolvedValue({ items: [], nextCursor: undefined });
}

const periodOf = (call: number) =>
  getModelsWithImagesAndModelVersions.mock.calls[call][0].input.period;

describe('getModelsInfiniteHandler period fallback', () => {
  beforeEach(() => getModelsWithImagesAndModelVersions.mockReset());

  it('retries at AllTime when the period returns nothing', async () => {
    respondWith({ items: [], nextCursor: undefined }, { items: [ITEM], nextCursor: undefined });

    const result = await run({ periodFallback: true });

    expect(result.items).toHaveLength(1);
    expect(result.periodFallbackApplied).toBe(true);
    expect(periodOf(0)).toBe(MetricTimeframe.Month);
    expect(periodOf(1)).toBe(MetricTimeframe.AllTime);
  });

  it('resets the cursor on the retry so it starts from the top', async () => {
    // The loop writes each page's nextCursor back onto `input`, so an empty page that
    // still reports a next one leaves a stale cursor behind. Without the reset the retry
    // inherits it and resumes mid-list — the bug this asserts against. The first page
    // must therefore carry a nextCursor, or `input.cursor` is undefined either way and
    // the assertion holds vacuously.
    respondWith(
      { items: [], nextCursor: 'stale-cursor' },
      { items: [], nextCursor: undefined },
      { items: [ITEM], nextCursor: undefined }
    );

    await run({ periodFallback: true });

    const retry = getModelsWithImagesAndModelVersions.mock.calls.at(-1)[0].input;
    expect(retry.period).toBe(MetricTimeframe.AllTime);
    expect(retry.cursor).toBeUndefined();
  });

  it('does NOT retry when the caller is paging — an exhausted page is not an empty tag', async () => {
    respondWith({ items: [], nextCursor: undefined });

    const result = await run({ periodFallback: true, cursor: '500' });

    expect(getModelsWithImagesAndModelVersions).toHaveBeenCalledTimes(1);
    expect(result.periodFallbackApplied).toBeUndefined();
  });

  it('does NOT retry without the opt-in — an empty browse feed is the right answer', async () => {
    respondWith({ items: [], nextCursor: undefined });

    const result = await run({});

    expect(getModelsWithImagesAndModelVersions).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([]);
    expect(result.periodFallbackApplied).toBeUndefined();
  });

  it('does NOT retry when the period is already AllTime', async () => {
    respondWith({ items: [], nextCursor: undefined });

    await run({ periodFallback: true, period: MetricTimeframe.AllTime });

    expect(getModelsWithImagesAndModelVersions).toHaveBeenCalledTimes(1);
  });

  it('leaves a non-empty result alone', async () => {
    respondWith({ items: [ITEM], nextCursor: undefined });

    const result = await run({ periodFallback: true });

    expect(getModelsWithImagesAndModelVersions).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(1);
    expect(result.periodFallbackApplied).toBeUndefined();
  });

  it('carries a caller-dependent row set out of the retry', async () => {
    respondWith(
      { items: [], nextCursor: undefined },
      { items: [ITEM], nextCursor: undefined, isPrivate: true }
    );
    const c = ctx();

    await getModelsInfiniteHandler({
      input: { limit: 10, period: MetricTimeframe.Month, periodFallback: true },
      ctx: c,
    } as never);

    expect(c.cache.canCache).toBe(false);
  });
});

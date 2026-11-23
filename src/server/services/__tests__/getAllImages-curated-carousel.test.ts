/**
 * The model-page carousel and a creator's curated version showcase, through the real getAllImages:
 * a curated version serves exactly its ids in their order, even with the flag that picks the
 * cached-ids branch off; an empty curated list serves nothing; without one the live owner-first
 * carousel is unchanged. The showcase is answered at the database and the page's query is captured
 * where it leaves for the database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as FliptClient from '../../flipt/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { answerShowcaseQueries } from '~/__tests__/mocks/showcase-queries';

const pageQueries = vi.hoisted(() => [] as string[]);
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  queryWithTimeout: vi.fn(async (_db: unknown, _ms: number, query: { text: string }) => {
    pageQueries.push(query.text);
    return { rows: [] };
  }),
}));
// The model-version-cache flag is off: a curated showcase must take the cached-ids branch on its own.
vi.mock('../../flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(async () => false),
}));

const { getAllImages } = await import('../image.service');

const VERSION = 456;
const input = {
  browsingLevel: 1,
  prioritizedUserIds: [123],
  modelVersionId: VERSION,
  include: [],
} as never;

/** The version's showcase rows on civitai.red, in this order. */
const curate = (imageIds: number[]) =>
  answerShowcaseQueries(dbMock.dbRead.$queryRaw, {
    rows: imageIds.map((imageId, position) => ({
      modelVersionId: VERSION,
      modelId: 1,
      imageId,
      site: 'red' as const,
      source: 'Owner' as const,
      position,
    })),
  });

beforeEach(() => {
  pageQueries.length = 0;
});

describe('getAllImages: the carousel and a curated version showcase', () => {
  it('serves the curated ids in their order, without the owner-only filter', async () => {
    curate([30, 10, 20]);
    await getAllImages(input);
    const sql = pageQueries.at(-1) ?? '';
    expect(sql).toContain('array_position(ARRAY[30,10,20]::int[], i."id")');
    expect(sql).not.toMatch(/i\."userId" IN \(/);
  });

  it('serves an empty page, not an unfiltered one, when every curated image is hidden', async () => {
    answerShowcaseQueries(dbMock.dbRead.$queryRaw, {
      rows: [
        {
          modelVersionId: VERSION,
          modelId: 1,
          imageId: 30,
          site: 'red',
          source: 'Owner',
          excluded: true,
        },
      ],
    });
    const result = await getAllImages(input);
    expect(result.items).toEqual([]);
    expect(pageQueries).toEqual([]);
  });

  it('keeps the live owner-first carousel when the version has no curated list', async () => {
    curate([]);
    await getAllImages(input);
    const sql = pageQueries.at(-1) ?? '';
    expect(sql).not.toContain('array_position');
    expect(sql).toMatch(/i\."userId" IN \(/);
  });
});

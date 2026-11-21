import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ModelService from '~/server/services/model.service';
import type * as ResourceSelectService from '~/server/services/resource-select.service';
import type * as FliptClient from '~/server/flipt/client';
import { ModelSort } from '~/server/common/enums';

const {
  getModelsWithImagesAndModelVersions,
  getOfficialModelIds,
  getPersonalLeadModelIds,
  isFlipt,
} = vi.hoisted(() => ({
  getModelsWithImagesAndModelVersions: vi.fn(),
  getOfficialModelIds: vi.fn(),
  getPersonalLeadModelIds: vi.fn(),
  isFlipt: vi.fn(),
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModelsWithImagesAndModelVersions,
  getPersonalLeadModelIds,
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt,
}));
vi.mock('~/server/services/resource-select.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ResourceSelectService>()),
  getOfficialModelIds,
}));

import { getModelsInfiniteHandler } from '~/server/controllers/model.controller';

/**
 * /models on Hot with a base-model filter leads with the official checkpoints for that base. The
 * pinned rows come from the same feed query with `onlyModelIds`, so whatever the viewer's filters
 * (browsing level, blocked tags, excluded users, types) drop, the pin drops too; the main stream
 * excludes them on every page so a cursor never emits them twice.
 */

const OFFICIAL_A = 10;
const OFFICIAL_B = 11;
const OFFICIAL_LORA = 12;
const STREAM = [{ id: 1 }, { id: 2 }];

type Call = { input: Record<string, unknown>; onlyModelIds?: number[]; excludeModelIds?: number[] };
const calls = () => getModelsWithImagesAndModelVersions.mock.calls.map(([arg]) => arg as Call);

function feed({ pinnedRows }: { pinnedRows: { id: number }[] }) {
  getModelsWithImagesAndModelVersions.mockImplementation(async ({ onlyModelIds }: Call) =>
    onlyModelIds
      ? { items: pinnedRows, isPrivate: false }
      : { items: STREAM, isPrivate: false, nextCursor: undefined }
  );
}

async function run(input: Record<string, unknown>, ctxExtra: Record<string, unknown> = {}) {
  const ctx = {
    user: undefined,
    features: {},
    req: { headers: {} },
    cache: { canCache: true },
    ...ctxExtra,
  };
  const result = await getModelsInfiniteHandler({
    input: { limit: 20, browsingLevel: 1, excludedUserIds: [77], ...input },
    ctx,
  } as never);
  return result.items.map((m) => (m as { id: number }).id);
}

beforeEach(() => {
  getModelsWithImagesAndModelVersions.mockReset();
  getPersonalLeadModelIds.mockReset().mockResolvedValue([]);
  isFlipt.mockReset().mockResolvedValue(false);
  getOfficialModelIds.mockReset();
  getOfficialModelIds.mockResolvedValue([
    { id: OFFICIAL_A, type: 'Checkpoint' },
    { id: OFFICIAL_B, type: 'Checkpoint' },
    { id: OFFICIAL_LORA, type: 'LORA' },
  ]);
});

describe('model feed: official checkpoints first on Hot with a base-model filter', () => {
  it('leads with every official checkpoint for the base, in the order the Hot query returns them', async () => {
    // Two official checkpoints on one base (prod has Flux.1 D with five): their order is the feed
    // query's Hot order, not the official list's.
    feed({ pinnedRows: [{ id: OFFICIAL_B }, { id: OFFICIAL_A }] });

    expect(await run({ sort: ModelSort.Hot, baseModels: ['Flux.1 D'] })).toEqual([
      OFFICIAL_B,
      OFFICIAL_A,
      1,
      2,
    ]);

    const [pinned, stream] = calls();
    expect(pinned.onlyModelIds).toEqual([OFFICIAL_A, OFFICIAL_B]);
    expect(stream.excludeModelIds).toEqual([OFFICIAL_A, OFFICIAL_B]);
  });

  it('fetches the pin with the viewer’s own filters, so a model they would not see is not pinned', async () => {
    // The pinned query returns nothing: the official model failed the viewer's filters.
    feed({ pinnedRows: [] });

    expect(
      await run({ sort: ModelSort.Hot, baseModels: ['Flux.1 D'], types: ['Checkpoint'] })
    ).toEqual([1, 2]);

    const [pinned] = calls();
    expect(pinned.onlyModelIds).toEqual([OFFICIAL_A, OFFICIAL_B]);
    expect(pinned.input).toMatchObject({
      sort: ModelSort.Hot,
      baseModels: ['Flux.1 D'],
      types: ['Checkpoint'],
      browsingLevel: 1,
      excludedUserIds: [77],
    });
  });

  it('does not repeat the pin on page 2, and keeps it out of that page’s stream', async () => {
    feed({ pinnedRows: [{ id: OFFICIAL_A }] });

    expect(await run({ sort: ModelSort.Hot, baseModels: ['Flux.1 D'], cursor: '5|5' })).toEqual([
      1, 2,
    ]);

    expect(calls()).toHaveLength(1);
    expect(calls()[0].onlyModelIds).toBeUndefined();
    expect(calls()[0].excludeModelIds).toEqual([OFFICIAL_A, OFFICIAL_B]);
  });

  it.each([
    ['Hot without a base filter', { sort: ModelSort.Hot }],
    [
      'Highest Rated with a base filter',
      { sort: ModelSort.HighestRated, baseModels: ['Flux.1 D'] },
    ],
    ['a text search', { sort: ModelSort.Hot, baseModels: ['Flux.1 D'], query: 'flux' }],
  ])('leaves the feed unchanged for %s', async (_, input) => {
    feed({ pinnedRows: [{ id: OFFICIAL_A }] });

    expect(await run(input)).toEqual([1, 2]);

    expect(calls()).toHaveLength(1);
    expect(calls()[0].onlyModelIds).toBeUndefined();
    expect(calls()[0].excludeModelIds ?? []).toEqual([]);
  });
});

describe('model feed: the personal Hot lead', () => {
  const VIEWER = { id: 5, username: 'viewer', isModerator: false };
  const LEAD = [31, 30];
  const signedIn = { user: VIEWER };

  it('evaluates the flag per viewer, with their context', async () => {
    feed({ pinnedRows: [] });
    await run({ sort: ModelSort.Hot }, signedIn);
    expect(isFlipt).toHaveBeenCalledWith('personal-hot-lead', '5', expect.any(Object));
    const call = isFlipt.mock.calls.find(([flag]) => flag === 'personal-hot-lead')!;
    const context = call[2] as Record<string, string>;
    expect(Object.keys(context).length).toBeGreaterThan(0);
  });

  it('leads page 1 with the lead in its own order, ahead of the official pin and the stream', async () => {
    isFlipt.mockResolvedValue(true);
    getPersonalLeadModelIds.mockResolvedValue(LEAD);
    // The feed query returns Hot order (30 before 31); the lead's own order wins.
    getModelsWithImagesAndModelVersions.mockImplementation(async ({ onlyModelIds }: Call) =>
      onlyModelIds?.includes(30)
        ? { items: [{ id: 30 }, { id: 31 }], isPrivate: false }
        : onlyModelIds
        ? { items: [{ id: OFFICIAL_A }], isPrivate: false }
        : { items: STREAM, isPrivate: false, nextCursor: undefined }
    );

    expect(await run({ sort: ModelSort.Hot, baseModels: ['Flux.1 D'] }, signedIn)).toEqual([
      31,
      30,
      OFFICIAL_A,
      1,
      2,
    ]);
    const stream = calls().find((c) => !c.onlyModelIds)!;
    expect(stream.excludeModelIds).toEqual([31, 30, OFFICIAL_A, OFFICIAL_B]);
    expect(getPersonalLeadModelIds).toHaveBeenCalledWith({
      userId: 5,
      browsingLevel: 1,
      firstPage: true,
    });
  });

  it('keeps the lead out of later pages without fetching it again', async () => {
    isFlipt.mockResolvedValue(true);
    getPersonalLeadModelIds.mockResolvedValue(LEAD);
    feed({ pinnedRows: [] });

    expect(await run({ sort: ModelSort.Hot, cursor: '5|5' }, signedIn)).toEqual([1, 2]);
    expect(calls()).toHaveLength(1);
    expect(calls()[0].excludeModelIds).toEqual(LEAD);
    expect(getPersonalLeadModelIds).toHaveBeenCalledWith(
      expect.objectContaining({ firstPage: false })
    );
  });

  it.each([
    ['signed out', { sort: ModelSort.Hot }, {}],
    ['a scoped API key', { sort: ModelSort.Hot }, { ...signedIn, apiKeyId: 9, tokenScope: 1 }],
    ['another sort', { sort: ModelSort.HighestRated }, signedIn],
    ['a text search', { sort: ModelSort.Hot, query: 'flux' }, signedIn],
    ["a creator's page", { sort: ModelSort.Hot, username: 'someone' }, signedIn],
    ['the followed filter', { sort: ModelSort.Hot, followed: true }, signedIn],
  ])('gives no lead for %s', async (_, input, ctx) => {
    isFlipt.mockResolvedValue(true);
    getPersonalLeadModelIds.mockResolvedValue(LEAD);
    feed({ pinnedRows: [] });

    expect(await run(input, ctx)).toEqual([1, 2]);
    expect(getPersonalLeadModelIds).not.toHaveBeenCalled();
    expect(calls()[0].excludeModelIds ?? []).toEqual([]);
  });
});

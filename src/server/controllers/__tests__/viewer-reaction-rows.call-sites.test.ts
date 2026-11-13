import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each read that hands article or bounty-entry reactions to a client must ask for the viewer's rows only (their
// counts come from `stats`, see reactions.own-rows.render.test.ts). The data layer is stubbed to capture the select.

const captured = vi.hoisted(() => ({ select: undefined as unknown }));
const capture = async (args: { select?: unknown }) => {
  captured.select = args.select;
  throw new Error('captured');
};

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDbWithoutLag: async () => ({ article: { findFirst: capture } }),
}));
vi.mock('~/server/services/bounty-visibility', () => ({
  assertBountyVisible: vi.fn(async () => undefined),
  canViewBounty: vi.fn(async () => true),
}));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  BlockedByUsers: { getCached: vi.fn(async () => []) },
}));
vi.mock('~/server/services/bountyEntry.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEntryById: capture,
  getAllEntriesByBountyId: capture,
}));

const { getArticleById } = await import('~/server/services/article.service');
const { getBountyEntryHandler } = await import('~/server/controllers/bountyEntry.controller');
const { getBountyEntriesHandler } = await import('~/server/controllers/bounty.controller');

const VIEWER = 7;
const viewerRows = (userId: number | undefined) =>
  expect.objectContaining({
    reactions: expect.objectContaining({ where: { userId }, take: userId ? undefined : 0 }),
  });

beforeEach(() => {
  captured.select = undefined;
});

describe('article and bounty-entry reads select only the viewer’s reaction rows', () => {
  it.each([VIEWER, undefined])('article.getById, viewer %s', async (userId) => {
    await getArticleById({ id: 1, userId }).catch(() => undefined);
    expect(captured.select).toEqual(viewerRows(userId));
  });

  it.each([VIEWER, undefined])('bountyEntry.getById, viewer %s', async (userId) => {
    await getBountyEntryHandler({
      input: { id: 1 },
      ctx: { user: userId ? { id: userId } : undefined } as never,
    }).catch(() => undefined);
    expect(captured.select).toEqual(viewerRows(userId));
  });

  it.each([VIEWER, undefined])('bounty.getEntries, viewer %s', async (userId) => {
    await getBountyEntriesHandler({
      input: { id: 1 } as never,
      ctx: { user: userId ? { id: userId } : undefined } as never,
    }).catch(() => undefined);
    expect(captured.select).toEqual(viewerRows(userId));
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for the avatar fan-out — see the header of owner-avatar-index.ts for why
 * the removal-side leg in collection-media-index cannot cover a replacement.
 *
 * Every id is distinct from the cap constant, so a module that hardcoded one could not
 * pass.
 */

const { mockCollections, mockBounties, mockComics } = vi.hoisted(() => ({
  mockCollections: vi.fn(),
  mockBounties: vi.fn(),
  mockComics: vi.fn(),
}));

vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: mockCollections },
  bountiesSearchIndex: { queueUpdate: mockBounties },
  comicsSearchIndex: { queueUpdate: mockComics },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { queueOwnerAvatarReindex } from '~/server/services/owner-avatar-index';

const USER_ID = 3319;
const COLLECTION_A = 8801;
const COLLECTION_B = 9107;
const BOUNTY_A = 4412;
const COMIC_A = 6653;

const sqlOf = (call: unknown[]) => Array.from(call[0] as string[]).join('?');

/** Answers each entity's lookup by the table it names. */
function primeLookups({
  collections = [COLLECTION_A, COLLECTION_B],
  bounties = [BOUNTY_A],
  comics = [COMIC_A],
}: { collections?: number[]; bounties?: number[]; comics?: number[] } = {}) {
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = Array.from(strings).join('?');
    const ids = sql.includes('"Collection"')
      ? collections
      : sql.includes('"Bounty"')
      ? bounties
      : comics;
    return ids.map((id) => ({ id }));
  });
}

const update = (id: number) => ({ id, action: SearchIndexUpdateQueueAction.Update });

const logNamed = (name: string) =>
  loggingMock.logToAxiom.mock.calls
    .map((c) => c[0] as { name?: string; message?: string; error?: unknown })
    .find((a) => a?.name === name);

const serialisedError = (name: string) =>
  JSON.parse(JSON.stringify({ e: logNamed(name)?.error })).e as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('queueOwnerAvatarReindex', () => {
  it('rebuilds all three indexes that denormalize the avatar', async () => {
    primeLookups();

    const result = await queueOwnerAvatarReindex({ userId: USER_ID, source: 'avatar-replace' });

    expect(mockCollections).toHaveBeenCalledWith([update(COLLECTION_A), update(COLLECTION_B)]);
    expect(mockBounties).toHaveBeenCalledWith([update(BOUNTY_A)]);
    expect(mockComics).toHaveBeenCalledWith([update(COMIC_A)]);
    expect(result).toEqual({ collections: 2, bounties: 1, comics: 1 });
  });

  // Ownership, not membership: the avatar rides on `user.profilePicture`, which every
  // document carries whatever it contains — a join through the entity's items would find
  // a different set, and nothing at all for an empty one.
  it('resolves each entity by its own userId column', async () => {
    primeLookups();

    await queueOwnerAvatarReindex({ userId: USER_ID, source: 'avatar-replace' });

    const statements = dbMock.dbWrite.$queryRaw.mock.calls.map(sqlOf);
    expect(statements).toHaveLength(3);
    for (const sql of statements) expect(sql).toMatch(/WHERE "userId" = \?/);
    expect(statements.some((s) => s.includes('"Collection"'))).toBe(true);
    expect(statements.some((s) => s.includes('"Bounty"'))).toBe(true);
    expect(statements.some((s) => s.includes('"ComicProject"'))).toBe(true);
    for (const call of dbMock.dbWrite.$queryRaw.mock.calls)
      expect((call as unknown[]).slice(1)).toContain(USER_ID);
  });

  it('does not fan out to the images index', async () => {
    primeLookups();

    await queueOwnerAvatarReindex({ userId: USER_ID, source: 'avatar-replace' });

    for (const sql of dbMock.dbWrite.$queryRaw.mock.calls.map(sqlOf))
      expect(sql).not.toMatch(/FROM "Image"/);
  });

  it('queues nothing for an entity the user owns none of', async () => {
    primeLookups({ bounties: [] });

    const result = await queueOwnerAvatarReindex({ userId: USER_ID, source: 'avatar-replace' });

    expect(mockBounties).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('bounties');
    expect(mockCollections).toHaveBeenCalled();
  });

  it('still rebuilds the other indexes when one lookup fails', async () => {
    dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join('?');
      if (sql.includes('"Bounty"')) throw new Error('connection reset');
      return sql.includes('"Collection"') ? [{ id: COLLECTION_A }] : [{ id: COMIC_A }];
    });

    await queueOwnerAvatarReindex({ userId: USER_ID, source: 'avatar-replace' });

    expect(mockCollections).toHaveBeenCalledWith([update(COLLECTION_A)]);
    expect(mockComics).toHaveBeenCalledWith([update(COMIC_A)]);
    expect(serialisedError('owner-avatar-index-resolve-failed')).toMatchObject({
      name: 'Error',
      message: 'connection reset',
    });
  });

  it('still rebuilds the other indexes when one enqueue fails', async () => {
    primeLookups();
    // `Once`, not a standing rejection: `clearAllMocks` resets calls but keeps
    // implementations, so a standing one would leak into every test below.
    mockCollections.mockRejectedValueOnce(new Error('redis unavailable'));

    const result = await queueOwnerAvatarReindex({ userId: USER_ID, source: 'avatar-replace' });

    expect(mockBounties).toHaveBeenCalled();
    expect(mockComics).toHaveBeenCalled();
    expect(result).not.toHaveProperty('collections');
    expect(serialisedError('owner-avatar-index-enqueue-failed')).toMatchObject({
      name: 'Error',
      message: 'redis unavailable',
    });
  });

  it('never throws, so a committed profile save cannot fail on bookkeeping', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(new Error('deadlock detected'));

    await expect(
      queueOwnerAvatarReindex({ userId: USER_ID, source: 'avatar-replace' })
    ).resolves.toEqual({});
  });

  it('bounds the lookup in SQL, not after it', async () => {
    primeLookups();

    await queueOwnerAvatarReindex({ userId: USER_ID, source: 'avatar-replace' });

    // A cap applied in JS still reads every row into memory first.
    for (const sql of dbMock.dbWrite.$queryRaw.mock.calls.map(sqlOf))
      expect(sql).toMatch(/LIMIT \?/);
  });

  it('caps the fan-out and says so rather than truncating silently', async () => {
    primeLookups({ collections: Array.from({ length: 10_001 }, (_, i) => 30_000 + i) });

    await queueOwnerAvatarReindex({ userId: USER_ID, source: 'avatar-replace' });

    const queued = mockCollections.mock.calls.flatMap((c) => c[0] as unknown[]);
    expect(queued).toHaveLength(10_000);
    // No figure is quoted — the lookup stops one past the cap, so any number would be 1.
    const warning = logNamed('owner-avatar-index-truncated');
    expect(warning?.message).toContain('unknown number');
    expect(warning?.message).not.toMatch(/\b10001\b/);
  });
});

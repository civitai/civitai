import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';
import type { CrucibleEntrySubscriber } from '~/server/services/crucible-entry-accepted';

const { acceptCrucibleEntry, revokeCrucibleEntry, sweepAcceptedCrucibleEntries } = await import(
  '~/server/services/crucible-entry-accepted'
);
const { visibleEntryImageSql } = await import('~/server/services/crucible-entry-sql');

const REVIEW_KEY = 'system:crucible-theme-review';
const TAG = 'rally';

// Hashes held in memory, so "already accepted" is the real record the code wrote.
const hashes = new Map<string, Map<string, string>>();
let reviewConfig: string | null = null;

// The rows the queries read: entries by id, and each crucible's current tags. Every crucible here is
// running.
type Row = { crucibleId: number; userId: number; imageId: number | null };
const rows = new Map<number, Row>();
const tags = new Map<number, string[]>();

const subscriber = (eventTags: string[] = [TAG]) => ({
  name: 'test',
  eventTags,
  accept: vi.fn<CrucibleEntrySubscriber['accept']>().mockResolvedValue(undefined),
  revoke: vi.fn<CrucibleEntrySubscriber['revoke']>().mockResolvedValue(undefined),
});

/** A subscriber that keeps what it has granted, the way an award table would. */
const granting = () => {
  const granted = new Set<number>();
  const sub = subscriber();
  sub.accept.mockImplementation(async ({ entryId }) => void granted.add(entryId));
  sub.revoke.mockImplementation(async ({ entryId }) => void granted.delete(entryId));
  return { sub, granted };
};

const entry = (entryId: number, crucibleId = 7) => ({ entryId, crucibleId, userId: 100 + entryId });
const enter = (entryId: number, crucibleId = 7) => {
  const ref = entry(entryId, crucibleId);
  rows.set(entryId, { crucibleId, userId: ref.userId, imageId: 1000 + entryId });
  if (!tags.has(crucibleId)) tags.set(crucibleId, [TAG]);
  return ref;
};

const sqlOf = (args: unknown[]) => {
  const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
  return Prisma.sql(strings, ...values);
};
const withImage = () => [...rows].filter(([, row]) => row.imageId !== null);

beforeEach(() => {
  vi.clearAllMocks();
  hashes.clear();
  rows.clear();
  tags.clear();
  reviewConfig = null;
  const { sysRedis } = redisMock;
  sysRedis.get.mockImplementation(async (key: string) =>
    key === REVIEW_KEY ? reviewConfig : null
  );
  sysRedis.hExists.mockImplementation(
    async (key: string, field: string) => hashes.get(key)?.has(field) ?? false
  );
  sysRedis.hGetAll.mockImplementation(async (key: string) =>
    Object.fromEntries(hashes.get(key) ?? [])
  );
  sysRedis.hSet.mockImplementation(async (key: string, field: string, value: string) => {
    const hash = hashes.get(key) ?? new Map<string, string>();
    hash.set(field, value);
    hashes.set(key, hash);
    return 1;
  });
  sysRedis.hDel.mockImplementation(async (key: string, field: string) =>
    hashes.get(key)?.delete(field) ? 1 : 0
  );
  sysRedis.expire.mockResolvedValue(true);
  dbMock.dbRead.crucible.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => ({ eventTags: tags.get(where.id) ?? [] })) as never);
  // Running tagged crucibles, then one crucible's judgeable entries outside its accepted ids.
  dbMock.dbRead.$queryRaw.mockImplementation((async (...args: unknown[]) => {
    const query = sqlOf(args);
    if (!query.sql.includes('JOIN "CrucibleEntry"'))
      return [...tags]
        .filter(([, t]) => t.includes(TAG))
        .map(([id, eventTags]) => ({ id, eventTags }));
    const [crucibleId, acceptedIds] = query.values as [number, number[]];
    const limit = query.values.at(-1) as number;
    return withImage()
      .filter(([id, row]) => row.crucibleId === crucibleId && !acceptedIds.includes(id))
      .slice(0, limit)
      .map(([entryId, row]) => ({ entryId, crucibleId: row.crucibleId, userId: row.userId }));
  }) as never);
  // The primary's checks: is this entry still in its crucible, and which of these still are.
  dbMock.dbWrite.$queryRaw.mockImplementation((async (...args: unknown[]) => {
    const query = sqlOf(args);
    if (query.sql.includes('AS ok')) {
      const id = query.values[0] as number;
      return rows.get(id)?.imageId ? [{ ok: true }] : [];
    }
    const ids = query.values[0] as number[];
    return withImage()
      .filter(([id]) => ids.includes(id))
      .map(([id]) => ({ id }));
  }) as never);
});

describe('acceptCrucibleEntry', () => {
  it('tells an interested subscriber once, however often it is called', async () => {
    const sub = subscriber();
    const ref = enter(1);

    expect(await acceptCrucibleEntry(ref, [sub])).toBe(true);
    expect(await acceptCrucibleEntry(ref, [sub])).toBe(false);

    expect(sub.accept).toHaveBeenCalledTimes(1);
    expect(sub.accept).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: 1,
        crucibleId: 7,
        userId: 101,
        acceptedAt: expect.any(Date),
      })
    );
  });

  it('leaves the entry unaccepted when a subscriber fails, so the next call retries it', async () => {
    const sub = subscriber();
    sub.accept.mockRejectedValueOnce(new Error('down'));
    const ref = enter(1);

    await expect(acceptCrucibleEntry(ref, [sub])).rejects.toThrow('down');
    expect(await acceptCrucibleEntry(ref, [sub])).toBe(true);

    expect(sub.accept).toHaveBeenCalledTimes(2);
  });

  it('takes back what an earlier subscriber granted when a later one fails', async () => {
    const first = granting();
    const second = subscriber();
    second.accept.mockRejectedValueOnce(new Error('down'));
    const untouched = subscriber();

    await expect(acceptCrucibleEntry(enter(1), [first.sub, second, untouched])).rejects.toThrow(
      'down'
    );

    expect([...first.granted]).toEqual([]);
    expect(second.revoke).toHaveBeenCalledTimes(1);
    expect(untouched.accept).not.toHaveBeenCalled();
    expect(untouched.revoke).not.toHaveBeenCalled();
  });

  it('skips a subscriber whose tags the crucible does not carry', async () => {
    const sub = subscriber(['other-event']);

    await acceptCrucibleEntry(enter(1), [sub]);

    expect(sub.accept).not.toHaveBeenCalled();
  });
});

describe('acceptCrucibleEntry racing a removal', () => {
  it('grants nothing for an entry withdrawn after the sweep listed it', async () => {
    const { sub, granted } = granting();
    const ref = enter(1);
    rows.get(1)!.imageId = null;

    expect(await acceptCrucibleEntry(ref, [sub])).toBe(false);

    expect(sub.accept).not.toHaveBeenCalled();
    expect(granted.size).toBe(0);
  });

  it('grants nothing when the revoke lands while the subscribers are running', async () => {
    const { sub, granted } = granting();
    const grant = sub.accept.getMockImplementation()!;
    sub.accept.mockImplementation(async (accepted) => {
      // The entrant withdraws mid-run: its revoke finishes before this grant is written.
      rows.get(1)!.imageId = null;
      await revokeCrucibleEntry(entry(1), [sub]);
      await grant(accepted);
    });

    expect(await acceptCrucibleEntry(enter(1), [sub])).toBe(false);

    expect(granted.size).toBe(0);
  });
});

describe('acceptCrucibleEntry racing a removal, after the record', () => {
  it('takes the grant back when the entry leaves just after it was recorded', async () => {
    const { sub, granted } = granting();
    const ref = enter(1);
    const record = redisMock.sysRedis.hSet.getMockImplementation()!;
    redisMock.sysRedis.hSet.mockImplementationOnce(async (...args: unknown[]) => {
      rows.get(1)!.imageId = null;
      return (record as (...a: unknown[]) => Promise<number>)(...args);
    });

    expect(await acceptCrucibleEntry(ref, [sub])).toBe(false);

    expect(granted.size).toBe(0);
  });
});

describe('revokeCrucibleEntry', () => {
  it('takes the entry back and lets it be accepted again, without throwing on a failure', async () => {
    const sub = subscriber();
    const ref = enter(1);
    await acceptCrucibleEntry(ref, [sub]);
    sub.revoke.mockRejectedValueOnce(new Error('down'));

    await expect(revokeCrucibleEntry(ref, [sub])).resolves.toBeUndefined();
    expect(sub.revoke).toHaveBeenCalledWith(ref);
    expect(await acceptCrucibleEntry(ref, [sub])).toBe(true);
  });

  it('reaches every subscriber when an earlier one fails to revoke', async () => {
    const first = subscriber();
    const second = granting();
    const ref = enter(1);
    await acceptCrucibleEntry(ref, [first, second.sub]);
    first.revoke.mockRejectedValueOnce(new Error('down'));

    await expect(revokeCrucibleEntry(ref, [first, second.sub])).resolves.toBeUndefined();

    expect(first.revoke).toHaveBeenCalledWith(ref);
    expect(second.granted.size).toBe(0);
  });

  it('reaches the subscriber that granted the entry after the crucible loses its tag', async () => {
    const { sub, granted } = granting();
    const ref = enter(1);
    await acceptCrucibleEntry(ref, [sub]);
    tags.set(7, []);

    await revokeCrucibleEntry(ref, [sub]);

    expect(granted.size).toBe(0);
  });
});

describe('sweepAcceptedCrucibleEntries', () => {
  it('accepts the judgeable entries not yet accepted, and none twice', async () => {
    const sub = subscriber();
    enter(1);
    enter(2);
    enter(3, 8);

    expect(await sweepAcceptedCrucibleEntries([sub])).toMatchObject({ accepted: 3, failed: 0 });
    expect(await sweepAcceptedCrucibleEntries([sub])).toMatchObject({ accepted: 0 });
    expect(sub.accept).toHaveBeenCalledTimes(3);
    // The crucible list carries the tags, so no entry reads them again.
    expect(dbMock.dbRead.crucible.findUnique).not.toHaveBeenCalled();
  });

  it('accepts a backlog over several sweeps, never re-reading what it already accepted', async () => {
    const sub = subscriber();
    for (let id = 1; id <= 250; id++) enter(id, id % 2 ? 7 : 8);

    const first = await sweepAcceptedCrucibleEntries([sub]);
    const second = await sweepAcceptedCrucibleEntries([sub]);

    expect(first.accepted).toBeLessThan(250);
    expect(first.accepted + second.accepted).toBe(250);
    expect(new Set(sub.accept.mock.calls.map(([e]) => e.entryId)).size).toBe(250);
  });

  it('counts an entry whose subscriber failed, and still accepts the rest', async () => {
    const sub = subscriber();
    sub.accept.mockImplementation(async ({ entryId }) => {
      if (entryId === 2) throw new Error('down');
    });
    enter(1);
    enter(2);
    enter(3);

    expect(await sweepAcceptedCrucibleEntries([sub])).toMatchObject({ accepted: 2, failed: 1 });
    sub.accept.mockResolvedValue(undefined);
    expect(await sweepAcceptedCrucibleEntries([sub])).toMatchObject({ accepted: 1, failed: 0 });
  });

  it.each([
    ['its image is deleted', () => void (rows.get(1)!.imageId = null)],
    ['its entrant deletes their account', () => void rows.delete(1)],
  ])('takes back an accepted entry once %s, and grants only the re-entry', async (_, leave) => {
    const { sub, granted } = granting();
    enter(1);
    await sweepAcceptedCrucibleEntries([sub]);
    expect([...granted]).toEqual([1]);

    leave();
    enter(2);
    expect(await sweepAcceptedCrucibleEntries([sub])).toMatchObject({ revoked: 1, accepted: 1 });

    expect([...granted]).toEqual([2]);
    expect(sub.revoke).toHaveBeenCalledWith({ entryId: 1, crucibleId: 7, userId: 101 });
  });

  it('accepts no entry of a crucible listed for an AI theme review', async () => {
    reviewConfig = JSON.stringify({
      crucibles: { '8': { theme: 'Hats', judgeId: 1, mode: 'enforce' } },
    });
    const sub = subscriber();
    enter(1);
    enter(2, 8);

    await sweepAcceptedCrucibleEntries([sub]);

    expect(sub.accept).toHaveBeenCalledTimes(1);
    expect(sub.accept).toHaveBeenCalledWith(expect.objectContaining({ entryId: 1 }));
  });

  it('accepts nothing while the review config is unreadable', async () => {
    const sub = subscriber();
    reviewConfig = '{ not json';
    enter(1);

    expect(await sweepAcceptedCrucibleEntries([sub])).toMatchObject({ skipped: true, accepted: 0 });
    expect(sub.accept).not.toHaveBeenCalled();
  });

  it('reads nothing when no subscriber listens', async () => {
    await sweepAcceptedCrucibleEntries([]);

    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});

// The fakes above stand in for the queries, so the clauses themselves are pinned here as text.
describe('the SQL the sweep runs', () => {
  const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  /** The value bound to the one `?` in `fragment`, which must appear in the query once. */
  const bound = (query: Prisma.Sql, fragment: string) => {
    const sql = squash(query.sql);
    const at = sql.indexOf(fragment);
    expect(at, fragment).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf(fragment, at + 1), fragment).toBe(-1);
    const placeholder = at + fragment.indexOf('?');
    return query.values[(sql.slice(0, placeholder).match(/\?/g) ?? []).length];
  };
  const visible = squash(visibleEntryImageSql(Prisma.sql`c."nsfwLevel"`, 0).sql);
  const lastQuery = (fn: typeof dbMock.dbRead.$queryRaw) =>
    sqlOf(fn.mock.calls.at(-1) as unknown[]);

  it('lists the running crucibles carrying a subscribed tag', async () => {
    await sweepAcceptedCrucibleEntries([subscriber()]);
    const query = sqlOf(dbMock.dbRead.$queryRaw.mock.calls[0] as unknown[]);

    expect(squash(query.sql)).toMatch(/^SELECT c\.id, c\."eventTags" FROM "Crucible" c WHERE/);
    expect(bound(query, 'c."eventTags" && ?::text[]')).toEqual([TAG]);
    expect(bound(query, 'c.status = ?::"CrucibleStatus"')).toBe('Active');
    expect(squash(query.sql)).toContain('AND c."endAt" > now()');
  });

  it("lists one crucible's visible entries outside those accepted, capped", async () => {
    const sub = subscriber();
    await acceptCrucibleEntry(enter(1), [sub]);
    enter(2);
    await sweepAcceptedCrucibleEntries([sub]);
    const query = lastQuery(dbMock.dbRead.$queryRaw);

    expect(bound(query, 'WHERE c.id = ?')).toBe(7);
    expect(bound(query, 'AND ce.id <> ALL(?::int[])')).toEqual([1]);
    expect(squash(query.sql)).toContain(`AND ${visible}`);
    expect(bound(query, 'ORDER BY ce.id LIMIT ?')).toEqual(expect.any(Number));
  });

  it('accepts only an entry judges can still see in a running crucible', async () => {
    await acceptCrucibleEntry(enter(1), [subscriber()]);
    const query = sqlOf(dbMock.dbWrite.$queryRaw.mock.calls[0] as unknown[]);

    expect(bound(query, 'WHERE ce.id = ?')).toBe(1);
    expect(bound(query, 'c.status = ?::"CrucibleStatus"')).toBe('Active');
    expect(squash(query.sql)).toContain('AND c."endAt" > now()');
    expect(squash(query.sql)).toContain(`AND ${visible}`);
  });
});

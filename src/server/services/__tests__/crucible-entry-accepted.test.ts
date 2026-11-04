import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';
import type { CrucibleEntrySubscriber } from '~/server/services/crucible-entry-accepted';

const { acceptCrucibleEntry, revokeCrucibleEntry, sweepAcceptedCrucibleEntries } = await import(
  '~/server/services/crucible-entry-accepted'
);

const REVIEW_KEY = 'system:crucible-theme-review';
const TAG = 'rally';

// Hashes held in memory, so "already accepted" is the real record the code wrote.
const hashes = new Map<string, Map<string, string>>();
let reviewConfig: string | null = null;

const subscriber = (eventTags: string[] = [TAG]) => ({
  name: 'test',
  eventTags,
  accept: vi.fn<CrucibleEntrySubscriber['accept']>().mockResolvedValue(undefined),
  revoke: vi.fn<CrucibleEntrySubscriber['revoke']>().mockResolvedValue(undefined),
});

const entry = (entryId: number, crucibleId = 7) => ({ entryId, crucibleId, userId: 100 + entryId });

beforeEach(() => {
  vi.clearAllMocks();
  hashes.clear();
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
  dbMock.dbRead.crucible.findUnique.mockResolvedValue({ eventTags: [TAG] });
  dbMock.dbRead.$queryRaw.mockResolvedValue([]);
});

describe('acceptCrucibleEntry', () => {
  it('tells an interested subscriber once, however often it is called', async () => {
    const sub = subscriber();

    expect(await acceptCrucibleEntry(entry(1), [sub])).toBe(true);
    expect(await acceptCrucibleEntry(entry(1), [sub])).toBe(false);

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

    await expect(acceptCrucibleEntry(entry(1), [sub])).rejects.toThrow('down');
    expect(await acceptCrucibleEntry(entry(1), [sub])).toBe(true);

    expect(sub.accept).toHaveBeenCalledTimes(2);
  });

  it('skips a subscriber whose tags the crucible does not carry', async () => {
    const sub = subscriber(['other-event']);

    await acceptCrucibleEntry(entry(1), [sub]);

    expect(sub.accept).not.toHaveBeenCalled();
  });
});

describe('revokeCrucibleEntry', () => {
  it('takes the entry back and lets it be accepted again, without throwing on a failure', async () => {
    const sub = subscriber();
    await acceptCrucibleEntry(entry(1), [sub]);
    sub.revoke.mockRejectedValueOnce(new Error('down'));

    await expect(revokeCrucibleEntry(entry(1), [sub])).resolves.toBeUndefined();
    expect(sub.revoke).toHaveBeenCalledWith(entry(1));
    expect(await acceptCrucibleEntry(entry(1), [sub])).toBe(true);
  });
});

describe('sweepAcceptedCrucibleEntries', () => {
  it('accepts the judgeable entries not yet accepted, and none twice', async () => {
    const sub = subscriber();
    dbMock.dbRead.$queryRaw.mockResolvedValue([entry(1), entry(2), entry(3, 8)]);

    expect(await sweepAcceptedCrucibleEntries([sub])).toMatchObject({ accepted: 3, failed: 0 });
    expect(await sweepAcceptedCrucibleEntries([sub])).toMatchObject({ accepted: 0 });
    expect(sub.accept).toHaveBeenCalledTimes(3);
  });

  it('leaves a crucible with an AI theme review to the review', async () => {
    reviewConfig = JSON.stringify({
      crucibles: { '8': { theme: 'Hats', judgeId: 1, mode: 'enforce' } },
    });

    await sweepAcceptedCrucibleEntries([subscriber()]);

    const [strings, ...values] = dbMock.dbRead.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const query = Prisma.sql(strings, ...values);
    expect(query.sql).toContain('c.id <> ALL(');
    expect(query.values).toContainEqual([8]);
  });

  it('accepts nothing while the review config is unreadable', async () => {
    const sub = subscriber();
    reviewConfig = '{ not json';
    dbMock.dbRead.$queryRaw.mockResolvedValue([entry(1)]);

    expect(await sweepAcceptedCrucibleEntries([sub])).toMatchObject({ skipped: true, accepted: 0 });
    expect(sub.accept).not.toHaveBeenCalled();
  });

  it('reads nothing when no subscriber listens', async () => {
    await sweepAcceptedCrucibleEntries([]);

    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});

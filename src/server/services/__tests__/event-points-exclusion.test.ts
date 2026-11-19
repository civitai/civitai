import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { UserFlag } from '~/shared/constants/user-flags.constants';

vi.mock('~/server/events/points/sync', () => ({ syncOwnerEventHats: vi.fn() }));
vi.mock('~/server/events/points/roster-sync', () => ({ syncEventRosterMember: vi.fn() }));

const { setEventPointsExclusion } = await import('~/server/services/user.service');
const { syncOwnerEventHats } = await import('~/server/events/points/sync');
const { syncEventRosterMember } = await import('~/server/events/points/roster-sync');

const USER = 41;
const OTHER = 42;

describe('setEventPointsExclusion', () => {
  let db: PGlite;
  const flagsOf = async (id: number) =>
    (await db.query<{ flags: number }>(`SELECT flags FROM "User" WHERE id = $1`, [id])).rows[0]
      .flags;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE TABLE "User" (id int PRIMARY KEY, flags int NOT NULL DEFAULT 0)`);
    const raw = pgliteRaw(db);
    (dbMock.dbWrite.$executeRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      raw.executeRaw
    );
  });

  beforeEach(async () => {
    await db.exec(`TRUNCATE "User"`);
    await db.query(`INSERT INTO "User" (id, flags) VALUES ($1, $2), ($3, $2)`, [
      USER,
      UserFlag.DisablePayout,
      OTHER,
    ]);
  });

  it('sets and clears only the event-points bit, leaving DisablePayout and other users alone', async () => {
    await setEventPointsExclusion({ id: USER, setTo: true });
    expect(await flagsOf(USER)).toBe(UserFlag.DisablePayout | UserFlag.ExcludeFromEventPoints);
    await setEventPointsExclusion({ id: USER, setTo: true });
    expect(await flagsOf(USER)).toBe(UserFlag.DisablePayout | UserFlag.ExcludeFromEventPoints);

    await setEventPointsExclusion({ id: USER, setTo: false });
    expect(await flagsOf(USER)).toBe(UserFlag.DisablePayout);
    await setEventPointsExclusion({ id: USER, setTo: false });
    expect(await flagsOf(USER)).toBe(UserFlag.DisablePayout);

    expect(await flagsOf(OTHER)).toBe(UserFlag.DisablePayout);
  });

  // Excluded, the owner's hats stop earning and they leave their team's roster at once; let back
  // in, both come back. Each re-derive runs after the write, so it reads the new flags.
  it.each([true, false])(
    're-derives their hats and roster entry after the write (excluded: %s)',
    async (setTo) => {
      vi.clearAllMocks();
      await setEventPointsExclusion({ id: USER, setTo });
      const write = vi.mocked(dbMock.dbWrite.$executeRaw).mock.invocationCallOrder[0];
      expect(vi.mocked(syncOwnerEventHats).mock.calls).toEqual([[USER]]);
      expect(vi.mocked(syncEventRosterMember).mock.calls).toEqual([[USER]]);
      expect(vi.mocked(syncOwnerEventHats).mock.invocationCallOrder[0]).toBeGreaterThan(write);
      expect(vi.mocked(syncEventRosterMember).mock.invocationCallOrder[0]).toBeGreaterThan(write);
    }
  );
});

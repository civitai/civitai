import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCachedObject: vi.fn(() => ({
    fetch: async () => ({}),
    bust: async () => undefined,
    refresh: async () => undefined,
    flush: async () => undefined,
  })),
}));
vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn(async () => undefined),
  invalidateSession: vi.fn(async () => undefined),
}));

import { updateContentSettings } from '~/server/services/user.service';
import { getServerBrowsingLevel } from '~/server/utils/browsing-level';

const USER_ID = 4242;
const NARROWED = 1 | 2;

/** Every raw statement the service sent, flattened to text, so a settings-blob write is visible. */
function rawStatements() {
  const calls = [
    ...dbMock.dbWrite.$executeRaw.mock.calls,
    ...dbMock.dbWrite.$queryRaw.mock.calls,
    ...dbMock.dbWrite.$executeRawUnsafe.mock.calls,
    ...dbMock.dbWrite.$queryRawUnsafe.mock.calls,
  ];
  return calls.map((args) => JSON.stringify(args));
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.update.mockResolvedValue({ id: USER_ID } as never);
  // The settings-blob write returns the updated row; an empty result reads as a missing user.
  dbMock.dbWrite.$queryRawUnsafe.mockResolvedValue([{ settings: {} }] as never);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ settings: {} }] as never);
});

// The browsing level is ONE column on every domain. Red once kept its own copy in
// settings.redBrowsingLevel; the reader was removed and the writer was not, so a change made on
// red looked applied in-session and was gone after a reload. Do not reintroduce a per-domain copy
// without a reader on the client AND on the server.
describe('updateContentSettings: one browsing level on every domain', () => {
  it.each(['red', 'blue', 'green', undefined] as const)(
    'a level set on %s is written to the User column',
    async (domain) => {
      await updateContentSettings({ userId: USER_ID, browsingLevel: NARROWED, domain });

      expect(dbMock.dbWrite.user.update).toHaveBeenCalledTimes(1);
      expect(dbMock.dbWrite.user.update.mock.calls[0][0]).toMatchObject({
        where: { id: USER_ID },
        data: { browsingLevel: NARROWED },
      });
    }
  );

  it('the level a server-rendered path resolves after a change on red is the new one', async () => {
    await updateContentSettings({ userId: USER_ID, browsingLevel: NARROWED, domain: 'red' });

    // What the session carries after a reload is the column this write targeted.
    const written = dbMock.dbWrite.user.update.mock.calls[0]?.[0]?.data?.browsingLevel;
    expect(
      getServerBrowsingLevel({
        canViewNsfw: true,
        user: { showNsfw: true, browsingLevel: written as number | undefined },
      })
    ).toBe(NARROWED);
  });

  it('writes no red-only copy of the level into settings', async () => {
    await updateContentSettings({
      userId: USER_ID,
      browsingLevel: NARROWED,
      allowAds: false,
      domain: 'red',
    });

    const statements = rawStatements();
    // The settings blob IS written for allowAds, so the absence below is observable.
    expect(statements.some((s) => s.includes('allowAds'))).toBe(true);
    expect(statements.filter((s) => s.includes('redBrowsingLevel'))).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserService from '~/server/services/user.service';
import type * as ErrorHandling from '~/server/utils/errorHandling';

/**
 * Only the transaction client is fake: the strike service, the release and the mod-activity writer are
 * real, so the assertions read the user update and the audit insert the release makes.
 */

const { mockGetUserSettings, mockPatchUserSettings, mockHandleLogError } = vi.hoisted(() => ({
  mockGetUserSettings: vi.fn(),
  mockPatchUserSettings: vi.fn(),
  mockHandleLogError: vi.fn(),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserSettings: mockGetUserSettings,
  patchUserSettings: mockPatchUserSettings,
  queueModelMetricPrivacyReindex: vi.fn(),
}));
vi.mock('~/server/utils/errorHandling', async (importOriginal) => ({
  ...(await importOriginal<typeof ErrorHandling>()),
  handleLogError: mockHandleLogError,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { setUserSettingHandler } from '~/server/controllers/user.controller';

const USER_ID = 5;
const SYSTEM_USER_ID = -1;

type DbUser = { muted: boolean; mutedAt: Date | null; meta: Record<string, unknown> };

const strikeMuted: DbUser = {
  muted: true,
  mutedAt: null,
  meta: { muteReason: 'strike-escalation' },
};

function fakeTransaction(user: DbUser, points: number, { pendingScamCase = false } = {}) {
  const userUpdate = vi.fn().mockResolvedValue({ id: USER_ID });
  const executeRaw = vi.fn().mockResolvedValue(1);
  const tx = {
    $queryRaw: vi.fn(async (strings: string[]) => {
      const sql = strings.join(' ');
      if (sql.includes('SUM(points)')) return [{ sum: BigInt(points) }];
      if (sql.includes('FOR UPDATE')) return [{ meta: user.meta, muteExpiresAt: null }];
      return [];
    }),
    $executeRaw: executeRaw,
    user: { findUnique: vi.fn().mockResolvedValue(user), update: userUpdate },
    userRestriction: {
      findFirst: vi.fn(async () => (pendingScamCase ? { id: 9 } : null)),
    },
  };
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: any) => fn(tx));
  return { userUpdate, executeRaw };
}

const modActivityInserts = (executeRaw: ReturnType<typeof vi.fn>) =>
  executeRaw.mock.calls
    .filter(([strings]) => (strings as string[]).join(' ').includes('"ModActivity"'))
    .map(([, ...values]) => values);

const setSettings = (
  input: Record<string, unknown>,
  sessionUser: { muted: boolean; mutedAt: Date | null } = { muted: true, mutedAt: null }
) =>
  setUserSettingHandler({
    ctx: { user: { id: USER_ID, ...sessionUser }, features: {}, domain: 'blue' },
    input,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockReset();
  mockGetUserSettings.mockResolvedValue({});
  mockPatchUserSettings.mockResolvedValue({ tosLastSeenDate: new Date() });
});

describe('setUserSettingHandler: ToS acceptance releases a two-strike mute', () => {
  it.each(['tosLastSeenDate', 'tosGreenLastSeenDate', 'tosRedLastSeenDate'])(
    'lifts the mute and writes a system unmute when %s is accepted',
    async (key) => {
      const { userUpdate, executeRaw } = fakeTransaction(strikeMuted, 2);

      await setSettings({ [key]: new Date(), tosAcceptedHash: 'abc' });

      expect(userUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: USER_ID },
          data: expect.objectContaining({ muted: false, mutedAt: null, meta: {} }),
        })
      );
      expect(modActivityInserts(executeRaw)).toEqual([
        [SYSTEM_USER_ID, 'user', 'unmute', [USER_ID]],
      ]);
    }
  );

  it('keeps a scam auto-mute: accepting the Terms is not a way out of it', async () => {
    const { userUpdate, executeRaw } = fakeTransaction(
      { muted: true, mutedAt: null, meta: { muteReason: 'auto-mute-scam' } },
      2
    );

    await setSettings({ tosLastSeenDate: new Date() });

    expect(userUpdate).not.toHaveBeenCalled();
    expect(modActivityInserts(executeRaw)).toEqual([]);
  });

  it('keeps the review tier muted', async () => {
    const { userUpdate } = fakeTransaction(
      { ...strikeMuted, meta: { ...strikeMuted.meta, strikeFlaggedForReview: true } },
      3
    );

    await setSettings({ tosLastSeenDate: new Date() });

    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('keeps the mute while a pending scam case holds the account', async () => {
    const { userUpdate } = fakeTransaction(strikeMuted, 2, { pendingScamCase: true });

    await setSettings({ tosLastSeenDate: new Date() });

    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('opens no transaction for a settings write that is not a ToS acceptance', async () => {
    fakeTransaction(strikeMuted, 2);

    await setSettings({ allowAds: false });

    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('opens no transaction for an account that is not muted', async () => {
    fakeTransaction(strikeMuted, 2);

    await setSettings({ tosLastSeenDate: new Date() }, { muted: false, mutedAt: null });

    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it("opens no transaction for a moderator's mute", async () => {
    fakeTransaction(strikeMuted, 2);

    await setSettings({ tosLastSeenDate: new Date() }, { muted: true, mutedAt: new Date() });

    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('still returns the saved settings when the release fails', async () => {
    const saved = { tosLastSeenDate: new Date('2026-10-20') };
    mockPatchUserSettings.mockResolvedValue(saved);
    dbMock.dbWrite.$transaction.mockRejectedValue(new Error('lock timeout'));

    await expect(setSettings({ tosLastSeenDate: new Date() })).resolves.toEqual(saved);
    expect(mockHandleLogError).toHaveBeenCalled();
  });
});

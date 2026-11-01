import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeratorService from '~/server/services/moderator.service';
import type * as UserService from '~/server/services/user.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const TOKEN = 'test-system-account-profile-token-0';
const KEY_TOKEN = 'test-system-account-key-token-00000';
const MODERATION_ID = 77;
const SYSTEM_ID = 1001;

const { trackModActivity, forceUpdateUserIdentity, patchUserSettings } = vi.hoisted(() => ({
  trackModActivity: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  forceUpdateUserIdentity: vi.fn<(...args: unknown[]) => Promise<{ updated: boolean }>>(
    async () => ({ updated: true })
  ),
  patchUserSettings: vi.fn<(...args: unknown[]) => Promise<object>>(async () => ({})),
}));

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  forceUpdateUserIdentity,
  patchUserSettings,
}));

const logToAxiom = loggingMock.logToAxiom;
const handler = (await import('~/pages/api/admin/system-account-profile')).default;

type UserRow = {
  id: number;
  username: string;
  name: string | null;
  meta: unknown;
  settings: unknown;
  deletedAt: Date | null;
  bannedAt: Date | null;
  isModerator: boolean;
  roles: { role: string }[];
};
let users: UserRow[];

const systemUser = (overrides: Partial<UserRow> = {}): UserRow => ({
  id: SYSTEM_ID,
  username: 'TestAgent',
  name: 'Test Agent',
  meta: { systemAccount: true },
  settings: { chat: { dmPolicy: 'everyone' } },
  deletedAt: null,
  bannedAt: null,
  isModerator: false,
  roles: [],
  ...overrides,
});

function call(
  body: Record<string, unknown>,
  { token = TOKEN as string | null, rawQuery = '' } = {}
) {
  const headers = token === null ? {} : { 'x-admin-token': token };
  const url = `/api/admin/system-account-profile${rawQuery ? `?${rawQuery}` : ''}`;
  const req = { method: 'POST', query: {}, body: { actorUserId: 9, ...body }, headers, url };
  let status = 0;
  let payload: Record<string, unknown> = {};
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(data: Record<string, unknown>) {
      payload = data;
      return res;
    },
    send: () => res,
    setHeader: () => res,
    end: () => res,
  };
  return (
    handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse) as Promise<void>
  ).then(() => ({ status, body: payload }));
}

const wrote = () =>
  forceUpdateUserIdentity.mock.calls.length +
  patchUserSettings.mock.calls.length +
  trackModActivity.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  users = [systemUser()];
  dbMock.dbWrite.user.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      users.find((u) => u.id === where.id) ?? null) as never
  );
  setEnv({
    CIVITAI_MODERATION_USER_ID: String(MODERATION_ID),
    SYSTEM_ACCOUNT_PROFILE_TOKEN: TOKEN,
    SYSTEM_ACCOUNT_KEY_TOKEN: KEY_TOKEN,
  });
});

describe('POST /api/admin/system-account-profile', () => {
  it('admits its own token only', async () => {
    expect((await call({ userId: SYSTEM_ID, name: 'Agent' }, { token: null })).status).toBe(401);
    expect((await call({ userId: SYSTEM_ID, name: 'Agent' }, { token: KEY_TOKEN })).status).toBe(
      401
    );
    expect(wrote()).toBe(0);
    expect((await call({ userId: SYSTEM_ID, name: 'Agent' })).status).toBe(200);
  });

  it.each(['SYSTEM_ACCOUNT_KEY_TOKEN', 'WEBHOOK_TOKEN', 'JOB_TOKEN'])(
    'is closed while its token repeats %s',
    async (other) => {
      // Distinct per row: env overrides persist across tests in a file.
      const shared = `shared-${other}`.padEnd(40, 's');
      setEnv({ SYSTEM_ACCOUNT_PROFILE_TOKEN: shared, [other]: shared });
      expect((await call({ userId: SYSTEM_ID, name: 'Agent' }, { token: shared })).status).toBe(
        503
      );
      expect(wrote()).toBe(0);
    }
  );

  it('is closed while its token is unset', async () => {
    setEnv({ SYSTEM_ACCOUNT_PROFILE_TOKEN: undefined });
    expect((await call({ userId: SYSTEM_ID, name: 'Agent' }, { token: '' })).status).toBe(503);
    expect(wrote()).toBe(0);
  });

  it('refuses a query string', async () => {
    expect((await call({ userId: SYSTEM_ID, name: 'Agent' }, { rawQuery: 'a=1' })).status).toBe(
      400
    );
    expect(wrote()).toBe(0);
  });

  it.each([
    ['isModerator', { isModerator: true }],
    ['username', { username: 'Other' }],
    ['another settings key', { settings: { chat: { dmPolicy: 'nobody' }, allowAds: false } }],
    ['another chat key', { settings: { chat: { dmPolicy: 'nobody', holdNewAccounts: true } } }],
    ['an unknown DM policy', { settings: { chat: { dmPolicy: 'friends' } } }],
    ['a name over 128 characters', { name: 'x'.repeat(129) }],
    ['a blank name', { name: '   ' }],
    ['a name with a bidi override', { name: 'Agent\u202Eevil' }],
    ['a name with a zero-width space', { name: 'Ag\u200Bent' }],
    ['the reserved moderation name', { name: 'civitai moderation' }],
  ])('refuses %s with no write', async (_, extra) => {
    const { status } = await call({ userId: SYSTEM_ID, name: 'Agent', ...extra });
    expect(status).toBe(400);
    expect(wrote()).toBe(0);
  });

  it('refuses a request that sets nothing', async () => {
    expect((await call({ userId: SYSTEM_ID })).status).toBe(400);
    expect(wrote()).toBe(0);
  });

  it('refuses a request without an asserted actor', async () => {
    expect((await call({ userId: SYSTEM_ID, name: 'Agent', actorUserId: undefined })).status).toBe(
      400
    );
    expect(wrote()).toBe(0);
  });

  it.each([
    ['an ordinary account', systemUser({ meta: {} }), 403],
    ['a deleted system account', systemUser({ deletedAt: new Date() }), 403],
    ['a banned system account', systemUser({ bannedAt: new Date() }), 403],
    ['the shared moderation account', systemUser({ id: MODERATION_ID }), 403],
    ['a moderator system account', systemUser({ isModerator: true }), 403],
    [
      'a system account with moderator:admin',
      systemUser({ roles: [{ role: 'moderator:admin' }] }),
      403,
    ],
  ])('refuses %s with no write', async (_, row, code) => {
    users = [row];
    expect((await call({ userId: row.id, name: 'Agent' })).status).toBe(code);
    expect(wrote()).toBe(0);
  });

  it('answers 404 for a missing account', async () => {
    users = [];
    expect((await call({ userId: SYSTEM_ID, name: 'Agent' })).status).toBe(404);
    expect(wrote()).toBe(0);
  });

  it('reads the account on the primary', async () => {
    await call({ userId: SYSTEM_ID, name: 'Agent' });
    expect(dbMock.dbWrite.user.findUnique).toHaveBeenCalled();
    expect(dbMock.dbRead.user.findUnique).not.toHaveBeenCalled();
  });

  it('sets the display name only, never the username', async () => {
    users = [systemUser({ name: null })];
    const { status, body } = await call({ userId: SYSTEM_ID, name: '  Other Name  ' });
    expect(status).toBe(200);
    expect(body.changed).toEqual(['name']);
    expect(forceUpdateUserIdentity).toHaveBeenCalledTimes(1);
    expect(forceUpdateUserIdentity.mock.calls[0][0]).toStrictEqual({
      userId: SYSTEM_ID,
      name: 'Other Name',
    });
  });

  it.each([
    ['settings with no chat key', {}],
    ['chat holding other keys', { chat: { holdNewAccounts: true } }],
    ['no settings at all', null],
    ['chat stored as a non-object', { chat: 7 }],
  ])('merges the DM policy into %s', async (_, stored) => {
    users = [systemUser({ settings: stored })];
    const { status, body } = await call({
      userId: SYSTEM_ID,
      settings: { chat: { dmPolicy: 'nobody' } },
    });
    expect(status).toBe(200);
    expect(body.changed).toEqual(['settings.chat.dmPolicy']);
    expect(patchUserSettings).toHaveBeenCalledWith(SYSTEM_ID, {
      mergeInto: { chat: { dmPolicy: 'nobody' } },
      location: 'admin/system-account-profile',
    });
    expect(forceUpdateUserIdentity).not.toHaveBeenCalled();
  });

  it('audits a change as the system actor, logging field names and the asserted actor', async () => {
    const name = 'Secret Display Name';
    await call({ userId: SYSTEM_ID, name, settings: { chat: { dmPolicy: 'nobody' } } });
    expect(trackModActivity).toHaveBeenCalledWith(-1, {
      entityType: 'user',
      activity: 'setSystemAccountProfile',
      entityId: SYSTEM_ID,
    });
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'system-account-profile-set',
        details: {
          userId: SYSTEM_ID,
          changed: ['name', 'settings.chat.dmPolicy'],
          asserted_actor: 9,
        },
      })
    );
    expect(JSON.stringify(logToAxiom.mock.calls)).not.toContain(name);
  });

  it('writes, audits and logs nothing when every field already holds its value', async () => {
    const { status, body } = await call({
      userId: SYSTEM_ID,
      name: 'Test Agent',
      settings: { chat: { dmPolicy: 'everyone' } },
    });
    expect(status).toBe(200);
    expect(body.changed).toEqual([]);
    expect(wrote()).toBe(0);
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('reopens chat when a policy other than nobody is set while chat is switched off', async () => {
    users = [
      systemUser({ settings: { chat: { dmPolicy: 'everyone' }, features: { chat: false } } }),
    ];
    const { status, body } = await call({
      userId: SYSTEM_ID,
      settings: { chat: { dmPolicy: 'everyone' } },
    });
    expect(status).toBe(200);
    expect(body.changed).toEqual(['settings.chat.dmPolicy', 'settings.features.chat']);
    expect(patchUserSettings).toHaveBeenCalledWith(SYSTEM_ID, {
      mergeInto: { chat: { dmPolicy: 'everyone' }, features: { chat: true } },
      location: 'admin/system-account-profile',
    });
    expect(trackModActivity).toHaveBeenCalledTimes(1);
  });

  it('leaves chat switched off when the policy set is nobody', async () => {
    users = [
      systemUser({ settings: { chat: { dmPolicy: 'everyone' }, features: { chat: false } } }),
    ];
    await call({ userId: SYSTEM_ID, settings: { chat: { dmPolicy: 'nobody' } } });
    expect(patchUserSettings).toHaveBeenCalledWith(SYSTEM_ID, {
      mergeInto: { chat: { dmPolicy: 'nobody' } },
      location: 'admin/system-account-profile',
    });
  });

  it('writes only the field that differs', async () => {
    const { body } = await call({
      userId: SYSTEM_ID,
      name: 'Test Agent',
      settings: { chat: { dmPolicy: 'mutuals' } },
    });
    expect(body.changed).toEqual(['settings.chat.dmPolicy']);
    expect(forceUpdateUserIdentity).not.toHaveBeenCalled();
    expect(patchUserSettings).toHaveBeenCalledTimes(1);
  });
  it('still answers 200 when the audit row cannot be written', async () => {
    trackModActivity.mockRejectedValueOnce(new Error('db down'));
    const { status, body } = await call({ userId: SYSTEM_ID, name: 'Agent' });
    expect(status).toBe(200);
    expect(body).toEqual({ userId: SYSTEM_ID, changed: ['name'], auditRecorded: false });
  });

  it('audits a write that succeeded before a later one failed', async () => {
    patchUserSettings.mockRejectedValueOnce(new Error('boom'));
    const { status, body } = await call({
      userId: SYSTEM_ID,
      name: 'Agent',
      settings: { chat: { dmPolicy: 'nobody' } },
    });
    expect(status).toBe(500);
    expect(body).toMatchObject({ changed: ['name'], failed: ['settings.chat.dmPolicy'] });
    expect(trackModActivity).toHaveBeenCalledTimes(1);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'system-account-profile-set-failed',
        details: {
          userId: SYSTEM_ID,
          changed: ['name'],
          failed: { fields: ['settings.chat.dmPolicy'], error: 'Error' },
          asserted_actor: 9,
        },
      })
    );
  });

  it('audits a write that threw, since it may have committed', async () => {
    forceUpdateUserIdentity.mockRejectedValueOnce(new Error('after update'));
    const { status, body } = await call({
      userId: SYSTEM_ID,
      name: 'Agent',
      settings: { chat: { dmPolicy: 'nobody' } },
    });
    expect(status).toBe(500);
    expect(body).toMatchObject({ changed: [], failed: ['name'] });
    expect(trackModActivity).toHaveBeenCalledTimes(1);
    expect(patchUserSettings).not.toHaveBeenCalled();
  });
});

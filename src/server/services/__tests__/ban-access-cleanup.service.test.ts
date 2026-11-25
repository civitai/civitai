import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ApiKeyService from '~/server/services/api-key.service';

// The boundaries this leg calls, each covered on its own: token expiry, the orchestrator's auth
// cache, and the moderator alert channel.
const { expireClientTokens, revokeCivitaiUserTokens, notifyModAlert } = vi.hoisted(() => ({
  expireClientTokens: vi.fn(async (_clientId: string) => ({ expired: 0 })),
  revokeCivitaiUserTokens: vi.fn(async (_args: { userId: number }) => true),
  notifyModAlert: vi.fn(
    async (_title: string, _description: string, _opts?: { noMentions?: boolean }) =>
      'delivered' as const
  ),
}));
vi.mock('~/server/services/api-key.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiKeyService>()),
  expireClientTokens,
}));
vi.mock('~/server/services/orchestrator/civitai', () => ({ revokeCivitaiUserTokens }));
vi.mock('~/server/common/mod-alert', () => ({ notifyModAlert }));

const { disableOauthForBannedUser } = await import('../ban-access-cleanup.service');

const USER = 4242;
const ASSISTANT = `appassist-${USER}`;
const DEV = `appdev-${USER}-pose-board`;
const THIRD_PARTY = 'b1e0c0de-0000-4000-8000-000000000001';
// Prefix lookalikes owned by the banned user but naming ANOTHER user: not self-only.
const LOOKALIKE_DEV = `appdev-${USER}0-pose-board`;

const owned = (rows: { id: string; accessMode?: string; name?: string }[]) =>
  dbMock.dbWrite.oauthClient.findMany.mockResolvedValue(
    rows.map((r) => ({ name: 'An app', accessMode: 'open', ...r })) as never
  );

beforeEach(() => {
  vi.clearAllMocks();
  owned([{ id: ASSISTANT }, { id: DEV }, { id: THIRD_PARTY, name: 'Prompt Pal' }]);
  dbMock.dbWrite.apiKey.findMany.mockResolvedValue([{ userId: USER }, { userId: 99 }] as never);
  dbMock.dbWrite.oauthClient.updateMany.mockResolvedValue({ count: 2 } as never);
  dbMock.dbWrite.oauthConsent.deleteMany.mockResolvedValue({ count: 3 } as never);
});

describe('disableOauthForBannedUser', () => {
  it('🔴 disables ONLY the self-only clients (App Assistant, dev tunnel) and expires their tokens', async () => {
    const result = await disableOauthForBannedUser(USER);

    expect(dbMock.dbWrite.oauthClient.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.oauthClient.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [ASSISTANT, DEV] } },
      data: { accessMode: 'disabled' },
    });
    expect(expireClientTokens.mock.calls.map(([id]) => id)).toEqual([ASSISTANT, DEV]);
    expect(result).toMatchObject({ disabled: [ASSISTANT, DEV], flagged: [THIRD_PARTY] });
  });

  it('🔴 a third-party app the user owns is NOT disabled and its users keep their tokens; a moderator is told', async () => {
    owned([{ id: THIRD_PARTY, name: 'Prompt Pal' }, { id: LOOKALIKE_DEV }]);
    const result = await disableOauthForBannedUser(USER);

    expect(dbMock.dbWrite.oauthClient.updateMany).not.toHaveBeenCalled();
    expect(expireClientTokens).not.toHaveBeenCalled();
    expect(revokeCivitaiUserTokens).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      disabled: [],
      flagged: [THIRD_PARTY, LOOKALIKE_DEV],
      flagDelivery: 'delivered',
    });
    expect(notifyModAlert).toHaveBeenCalledTimes(1);
    const [, description, opts] = notifyModAlert.mock.calls[0];
    expect(description).toContain(`User ${USER}`);
    expect(description).toContain(`${THIRD_PARTY} (Prompt Pal, open)`);
    expect(description).toContain(LOOKALIKE_DEV);
    // The app names are user-written.
    expect(opts).toEqual({ noMentions: true });
  });

  it('🔴 revokes, at the orchestrator, every user who held a token under a disabled client', async () => {
    await disableOauthForBannedUser(USER);
    expect(dbMock.dbWrite.apiKey.findMany).toHaveBeenCalledWith({
      where: { clientId: { in: [ASSISTANT, DEV] } },
      select: { userId: true },
      distinct: ['userId'],
    });
    expect(revokeCivitaiUserTokens.mock.calls.map(([a]) => a.userId).sort((a, b) => a - b)).toEqual(
      [99, USER]
    );
  });

  it('🔴 deletes the consents the user gave, except to App Block clients, even when token expiry fails', async () => {
    expireClientTokens.mockRejectedValue(new Error('db down'));
    const result = await disableOauthForBannedUser(USER);
    expect(dbMock.dbWrite.oauthConsent.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, NOT: { clientId: { startsWith: 'appblk-' } } },
    });
    expect(result.consents).toBe(3);
  });

  it('leaves App Block clients out of the client read', async () => {
    await disableOauthForBannedUser(USER);
    expect(dbMock.dbWrite.oauthClient.findMany).toHaveBeenCalledWith({
      where: { userId: USER, NOT: { id: { startsWith: 'appblk-' } } },
      select: { id: true, name: true, accessMode: true },
    });
  });

  it('an already-disabled self-only client is not written again, and nothing is flagged without a third-party app', async () => {
    owned([{ id: ASSISTANT, accessMode: 'disabled' }]);
    const result = await disableOauthForBannedUser(USER);
    expect(dbMock.dbWrite.oauthClient.updateMany).not.toHaveBeenCalled();
    expect(notifyModAlert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ disabled: [], flagged: [], flagDelivery: null });
  });
});

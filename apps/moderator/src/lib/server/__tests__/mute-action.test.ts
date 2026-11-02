import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => [] as string[]);
const order = vi.hoisted(() => [] as string[]);
const revokeOrchestratorUserTokens = vi.hoisted(() =>
  vi.fn(async (_userId: number) => {
    order.push('revoke');
    return true;
  })
);
const bustKeyBestEffort = vi.hoisted(() =>
  vi.fn(async (_key: string, _opts: unknown) => {
    order.push('bust');
    return true;
  })
);
const invalidateUserSessions = vi.hoisted(() =>
  vi.fn(async (_userId: number) => {
    order.push('sessions');
  })
);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  // One canned row, so the mute's UPDATE reports a matched account.
  return { dbRead: capturingDb(captured, [{}]), dbWrite: capturingDb(captured, [{}]) };
});
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn(), recordModActivityBatch: vi.fn() }));
vi.mock('../user-activity', () => ({ recordUserActivity: vi.fn() }));
vi.mock('../sessions', () => ({ invalidateUserSessions }));
vi.mock('../orchestrator', () => ({ revokeOrchestratorUserTokens }));
vi.mock('../cache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bustKeyBestEffort,
}));
vi.mock('$env/dynamic/private', () => ({ env: { CIVITAI_APP_URL: 'https://civitai.com' } }));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: new Request('http://x', { headers: { cookie: 'civ-token=t' } }),
  }),
}));

const { setMuted } = await import('../user-actions.service');

beforeEach(() => {
  vi.clearAllMocks();
  captured.length = 0;
  order.length = 0;
});

describe('a moderator-app mute reaches the orchestrator and the cached standing', () => {
  it("drops the cached standing, ends the sessions, then revokes the account's orchestrator tokens", async () => {
    expect(await setMuted({ userId: 42, muted: true, moderatorId: 7 })).toEqual({ ok: true });

    expect(revokeOrchestratorUserTokens).toHaveBeenCalledWith(42);
    expect(bustKeyBestEffort).toHaveBeenCalledWith(
      expect.stringMatching(/account-standing:42$/),
      expect.anything()
    );
    // The orchestrator re-validates against the session, so the revoke must follow the logout.
    expect(order.indexOf('sessions')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('revoke')).toBeGreaterThan(order.indexOf('sessions'));
    expect(order.indexOf('bust')).toBeLessThan(order.indexOf('sessions'));
  });

  it('still revokes when ending the sessions fails', async () => {
    invalidateUserSessions.mockRejectedValueOnce(new Error('session store down'));
    await setMuted({ userId: 42, muted: true, moderatorId: 7 }).catch(() => undefined);
    expect(revokeOrchestratorUserTokens).toHaveBeenCalledWith(42);
  });

  it("expires the account's generation credentials in the main app, and again after the cache settles", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await setMuted({ userId: 42, muted: true, moderatorId: 7 });
      const calls = () =>
        fetchMock.mock.calls.filter(([url]) =>
          String(url).endsWith('/api/mod/user/expire-generation-credentials')
        );
      expect(calls()).toHaveLength(1);
      const init = (i: number) =>
        calls()[i][1] as RequestInit & { headers: Record<string, string> };
      expect(JSON.parse(String(init(0).body))).toEqual({ userId: 42 });
      await vi.runAllTimersAsync();
      expect(calls()).toHaveLength(2);
      expect(init(1).headers.cookie).toBe('civ-token=t');
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

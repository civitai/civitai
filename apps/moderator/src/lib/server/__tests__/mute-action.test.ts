import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'test-token' },
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: new Request('http://x', { headers: { cookie: 'civ-token=t' } }),
  }),
}));

const { setBanned, setMuted } = await import('../user-actions.service');

// Every test: `setMuted` posts to the main app, and a test must never reach a real host.
const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
  if (String(url).endsWith('/api/mod/user/cancel-pending-workflows')) order.push('cancel');
  return new Response('{}', { status: 200 });
});

beforeEach(() => {
  vi.clearAllMocks();
  captured.length = 0;
  order.length = 0;
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the feedback capture account', () => {
  it('is never muted, and nothing is written or sent', async () => {
    expect(await setMuted({ userId: -2, muted: true, moderatorId: 7 })).toEqual({
      ok: false,
      error: expect.stringMatching(/feedback page captures/),
    });
    expect(captured).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A ban from before the refusal can still be lifted.
  it('can still be unbanned', async () => {
    const result = await setBanned({ userId: -2, ban: false, moderatorId: 7 });
    expect(result).not.toEqual({
      ok: false,
      error: expect.stringMatching(/feedback page captures/),
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/mod/ban-user'))).toBe(
      true
    );
  });

  it('is never banned, and nothing is written or sent', async () => {
    expect(await setBanned({ userId: -2, ban: true, moderatorId: 7 })).toEqual({
      ok: false,
      error: expect.stringMatching(/feedback page captures/),
    });
    expect(captured).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
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

  // The bust comes first, so a submit while the cancel runs is refused; the revoke comes last.
  // Do not reorder them.
  it('drops the cached standing, cancels the pending generations, then ends the sessions and revokes', async () => {
    expect(await setMuted({ userId: 42, muted: true, moderatorId: 7 })).toEqual({ ok: true });
    expect(order.slice(0, 4)).toEqual(['bust', 'cancel', 'sessions', 'revoke']);
  });

  it('still mutes and revokes when the cancel fails', async () => {
    fetchMock.mockImplementationOnce(async (url: string | URL | Request) =>
      String(url).endsWith('/api/mod/user/cancel-pending-workflows')
        ? new Response('{}', { status: 500 })
        : new Response('{}', { status: 200 })
    );
    expect(await setMuted({ userId: 42, muted: true, moderatorId: 7 })).toEqual({ ok: true });
    expect(order.slice(0, 3)).toEqual(['bust', 'sessions', 'revoke']);
    expect(revokeOrchestratorUserTokens).toHaveBeenCalledWith(42);
  });

  it('cancels again in the delayed repeat, after its revoke', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      await setMuted({ userId: 42, muted: true, moderatorId: 7 });
      order.length = 0;
      await vi.runAllTimersAsync();
      expect(order).toEqual(['bust', 'revoke', 'cancel']);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires the account's generation credentials in the main app, and again after the cache settles", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      await setMuted({ userId: 42, muted: true, moderatorId: 7 });
      const calls = () =>
        fetchMock.mock.calls.filter(([url]) =>
          String(url).endsWith('/api/mod/user/expire-generation-credentials')
        );
      expect(calls()).toHaveLength(1);
      const init = (i: number) =>
        calls()[i][1] as unknown as RequestInit & { headers: Record<string, string> };
      expect(JSON.parse(String(init(0).body))).toEqual({ userId: 42 });
      await vi.runAllTimersAsync();
      expect(calls()).toHaveLength(2);
      expect(init(1).headers.cookie).toBe('civ-token=t');
    } finally {
      vi.useRealTimers();
    }
  });
});

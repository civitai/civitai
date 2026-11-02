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
  getRequestEvent: () => ({ locals: {}, request: new Request('http://x') }),
}));

const { setMuted } = await import('../user-actions.service');

beforeEach(() => {
  vi.clearAllMocks();
  captured.length = 0;
  order.length = 0;
});

describe('a moderator-app mute reaches the orchestrator and the cached standing', () => {
  it("revokes the account's orchestrator tokens and drops its cached standing, before the logout", async () => {
    expect(await setMuted({ userId: 42, muted: true, moderatorId: 7 })).toEqual({ ok: true });

    expect(revokeOrchestratorUserTokens).toHaveBeenCalledExactlyOnceWith(42);
    expect(bustKeyBestEffort).toHaveBeenCalledWith(
      expect.stringMatching(/account-standing:42$/),
      expect.anything()
    );
    expect(order.indexOf('revoke')).toBeLessThan(order.indexOf('sessions'));
    expect(order.indexOf('bust')).toBeLessThan(order.indexOf('sessions'));
  });
});

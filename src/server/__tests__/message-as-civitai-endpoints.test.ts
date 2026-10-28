import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks';
import type * as Grants from '~/server/services/moderator-grants';
import type * as Service from '~/server/services/message-as-civitai.service';

/**
 * Every Civitai Moderation endpoint holds the caller to `user.message.asCivitai`. The moderator app's form
 * actions check it too, but an API key reaches these directly, so this is the check that counts.
 */

const h = vi.hoisted(() => ({
  session: vi.fn(),
  hasGrant: vi.fn(),
  service: {
    sendAsCivitaiOnce: vi.fn(async () => ({ chatId: 1, messageId: 2, deduped: false })),
    getInbox: vi.fn(async () => []),
    getThread: vi.fn(async () => ({ chatId: 1, claim: null, messages: [] })),
    claimThread: vi.fn(async () => ({ claimed: true, moderatorId: 7, expiresAt: new Date() })),
    releaseThread: vi.fn(async () => true),
    getThreadChatIdForUser: vi.fn(async () => 1),
  },
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: h.session }));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/moderator-grants', async (importOriginal) => ({
  ...(await importOriginal<typeof Grants>()),
  hasModeratorGrant: h.hasGrant,
}));
vi.mock('~/server/services/message-as-civitai.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Service>()),
  ...h.service,
}));

const endpoints = {
  send: (await import('~/pages/api/mod/user/message-as-civitai')).default,
  inbox: (await import('~/pages/api/mod/messages/inbox')).default,
  thread: (await import('~/pages/api/mod/messages/thread')).default,
  claim: (await import('~/pages/api/mod/messages/claim')).default,
  release: (await import('~/pages/api/mod/messages/release')).default,
};

const calls = {
  send: {
    method: 'POST',
    body: { userId: 5, message: 'hi', idempotencyKey: 'key-00001' },
    service: 'sendAsCivitaiOnce',
  },
  inbox: { method: 'GET', query: {}, service: 'getInbox' },
  thread: { method: 'GET', query: { userId: '5' }, service: 'getThread' },
  claim: { method: 'POST', body: { userId: 5 }, service: 'claimThread' },
  release: { method: 'POST', body: { userId: 5 }, service: 'releaseThread' },
} as const;

function invoke(name: keyof typeof endpoints) {
  const c = calls[name] as { method: string; body?: object; query?: object };
  const req = { method: c.method, headers: {}, body: c.body ?? {}, query: c.query ?? {} };
  let status = 200;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json: () => res,
    setHeader: () => undefined,
    end: () => res,
  };
  return (endpoints[name] as (req: unknown, res: unknown) => Promise<unknown>)(req, res).then(
    () => status
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.session.mockResolvedValue({
    user: { id: 7, isModerator: true, permissions: [], bannedAt: null },
  });
  redisMock.sysRedis.multi.mockImplementation((() => {
    const chain = {
      set: () => chain,
      incr: () => chain,
      exec: async () => ['OK', 1],
    };
    return chain;
  }) as never);
});

describe.each(Object.keys(calls) as (keyof typeof calls)[])('%s', (name) => {
  it('refuses a moderator without user.message.asCivitai, and does nothing', async () => {
    h.hasGrant.mockResolvedValue(false);
    expect(await invoke(name)).toBe(403);
    expect(h.service[calls[name].service]).not.toHaveBeenCalled();
  });

  it('acts for a moderator holding the grant', async () => {
    h.hasGrant.mockResolvedValue(true);
    expect(await invoke(name)).toBe(200);
    expect(h.service[calls[name].service]).toHaveBeenCalled();
    expect(h.hasGrant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      'user.message.asCivitai'
    );
  });
});

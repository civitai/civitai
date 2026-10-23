import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { redisMock } from '~/__tests__/mocks';
import type * as ClickhouseClient from '~/server/clickhouse/client';

// The wrapper and `getServerAuthSession` are deliberately unmocked: the point is that this route is
// served through `defineModeratorEndpoint`, so only a moderator's session reaches the lift.
const { hubSession, moderateStorylineTitle } = vi.hoisted(() => ({
  hubSession: { current: null as null | { user: Record<string, unknown> } },
  moderateStorylineTitle: vi.fn(),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => null),
}));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => hubSession.current),
  maybeRollHubCookie: vi.fn(async () => undefined),
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  Tracker: class {
    retoolAudit = vi.fn();
  },
}));
vi.mock('~/server/services/storyline.service', () => ({ moderateStorylineTitle }));

const { default: handler } = (await import('~/pages/api/mod/storyline/lift-title-takedown')) as {
  default: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
};

const MODERATOR = { id: 4242, username: 'mod', isModerator: true, bannedAt: null, permissions: [] };
const MEMBER = { ...MODERATOR, isModerator: false };

async function call(body: Record<string, unknown>) {
  const req = {
    method: 'POST',
    url: '/api/mod/storyline/lift-title-takedown',
    headers: { host: 'civitai.com' },
    query: {},
    body,
    cookies: {},
  } as unknown as NextApiRequest;
  let status = 200;
  let json: unknown;
  const headers = new Map<string, unknown>();
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      json = value;
      return res;
    },
    send(value: unknown) {
      json = value;
      return res;
    },
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), value);
      return res;
    },
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    end: () => res,
    on: () => res,
    once: () => res,
  } as unknown as NextApiResponse;
  await handler(req, res);
  return { status, json };
}

const LIFT = { storylineId: 10, reviewedTitle: 'The title I read' };

beforeEach(() => {
  vi.clearAllMocks();
  hubSession.current = null;
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn(async () => ['OK', 1]),
  }));
  moderateStorylineTitle.mockResolvedValue({
    id: 10,
    tosViolation: false,
    tosViolationByScan: false,
    tosViolationByModerator: false,
  });
});

describe('/api/mod/storyline/lift-title-takedown', () => {
  it('lifts for the title the moderator reviewed', async () => {
    hubSession.current = { user: MODERATOR };
    const { status, json } = await call(LIFT);
    expect(status).toBe(200);
    expect(moderateStorylineTitle).toHaveBeenCalledExactlyOnceWith({
      id: 10,
      liftScanTakedown: { reviewedTitle: 'The title I read' },
      moderatorId: MODERATOR.id,
    });
    expect(json).toEqual({
      storylineId: 10,
      tosViolation: false,
      tosViolationByScan: false,
      tosViolationByModerator: false,
    });
  });

  it.each([
    ['no session', null, 401],
    ['a non-moderator session', { user: MEMBER }, 403],
  ])('refuses %s without lifting', async (_label, session, expected) => {
    hubSession.current = session;
    expect((await call(LIFT)).status).toBe(expected);
    expect(moderateStorylineTitle).not.toHaveBeenCalled();
  });

  it('refuses a lift with no reviewed title', async () => {
    hubSession.current = { user: MODERATOR };
    expect((await call({ storylineId: 10 })).status).toBe(400);
    expect(moderateStorylineTitle).not.toHaveBeenCalled();
  });

  // The spoke shows this message as the reason the lift was refused.
  it("answers the service's refusal as a 400 with its message", async () => {
    hubSession.current = { user: MODERATOR };
    moderateStorylineTitle.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'The title has changed since it was reviewed' })
    );
    const { status, json } = await call(LIFT);
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toContain('The title has changed since it was reviewed');
  });
});

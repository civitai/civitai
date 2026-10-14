import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * REST 429s on the shared-storage write routes carry the refusal's retry metadata as
 * `Retry-After` + `body.rateLimit` + `body.code` (civitai/civitai-app-starters#597), through
 * the REAL `handleEndpointError` (six routes) and increment's own catch. The router is
 * mocked to throw the refusal shape `throwSharedRateLimited` produces (the seam test pins that
 * shape end to end).
 */

const RATE_LIMIT = {
  retryAfterSeconds: 17,
  retryAt: '2031-04-05T06:07:08.000Z',
};

function refusal(message: string, cause: unknown = { rateLimit: RATE_LIMIT }) {
  return new TRPCError({ code: 'TOO_MANY_REQUESTS', message, cause });
}

function createMocks(body: unknown) {
  const req = {
    method: 'POST',
    body,
    query: {},
    url: '/api/v1/blocks/shared-storage/x',
    headers: { authorization: 'Bearer tok_rl', host: 'civitai.test' },
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as Record<string, unknown>;
  const state = { status: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  const res = {
    headersSent: false,
    status(c: number) {
      state.status = c;
      return res;
    },
    json(b: unknown) {
      state.body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      state.headers[k.toLowerCase()] = v;
      return res;
    },
    end() {
      return res;
    },
  };
  return { req, res, state };
}

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

type Handler = (req: { blockClaims?: BlockTokenClaims }, res: unknown) => unknown;

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: Handler) => (req: { blockClaims?: BlockTokenClaims }, res: unknown) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
  stashBlockActionDetail: vi.fn(),
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: Handler) => h }));

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  update: vi.fn(),
  vote: vi.fn(),
  unvote: vi.fn(),
  withdraw: vi.fn(),
  report: vi.fn(),
  increment: vi.fn(),
}));
vi.mock('~/server/routers/apps-shared.router', async () => {
  const zod = await import('zod');
  return {
    appendSharedRow: mocks.append,
    updateSharedRow: mocks.update,
    voteSharedRow: mocks.vote,
    unvoteSharedRow: mocks.unvote,
    withdrawSharedRow: mocks.withdraw,
    reportSharedRow: mocks.report,
    incrementSharedCounter: mocks.increment,
    SHARED_KEY_MAX: 64,
    SHARED_REASON_MAX: 500,
    sharedValueInput: zod.object({ title: zod.string().min(1) }),
  };
});

import appendHandler from '~/pages/api/v1/blocks/shared-storage/append';
import updateHandler from '~/pages/api/v1/blocks/shared-storage/update';
import voteHandler from '~/pages/api/v1/blocks/shared-storage/vote';
import unvoteHandler from '~/pages/api/v1/blocks/shared-storage/unvote';
import withdrawHandler from '~/pages/api/v1/blocks/shared-storage/withdraw';
import reportHandler from '~/pages/api/v1/blocks/shared-storage/report';
import incrementHandler from '~/pages/api/v1/blocks/shared-storage/increment';

// The prose carries a different number from `rateLimit.retryAfterSeconds` (17), so a layer that
// parsed the wait out of the message instead of forwarding the metadata fails.
const ROUTES = [
  {
    name: 'append',
    handler: appendHandler,
    body: { value: { title: 'rl 433' } },
    mock: mocks.append,
    message: 'Too many submissions — retry in 1849s',
  },
  {
    name: 'update',
    handler: updateHandler,
    body: { key: 'k-rl-417', value: { title: 'rl 433' } },
    mock: mocks.update,
    message: 'Too many submissions — retry in 1849s',
  },
  {
    name: 'vote',
    handler: voteHandler,
    body: { key: 'k-rl-417' },
    mock: mocks.vote,
    message: 'Too many votes — retry in 1849s',
  },
  {
    name: 'unvote',
    handler: unvoteHandler,
    body: { key: 'k-rl-417' },
    mock: mocks.unvote,
    message: 'Too many votes — retry in 1849s',
  },
  {
    name: 'withdraw',
    handler: withdrawHandler,
    body: { key: 'k-rl-417' },
    mock: mocks.withdraw,
    message: 'Too many withdrawals — retry in 1849s',
  },
  {
    name: 'report',
    handler: reportHandler,
    body: { key: 'k-rl-417', reason: 'spam' },
    mock: mocks.report,
    message: 'Too many reports — retry in 1849s',
  },
  {
    name: 'increment',
    handler: incrementHandler,
    body: { key: 'playcount:417' },
    mock: mocks.increment,
    message: 'Too many increments — retry in 1849s',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = {
    sub: 'user:42',
    appBlockId: 'apb',
    scopes: ['apps:storage:shared:write'],
  } as BlockTokenClaims;
});

describe('shared-storage REST 429 carries retry metadata', () => {
  it.each(ROUTES)(
    '$name: Retry-After, body.code and body.rateLimit; message unchanged',
    async ({ handler, body, mock, message }) => {
      mock.mockRejectedValueOnce(refusal(message));
      const { req, res, state } = createMocks(body);

      await handler(req as never, res as never);

      expect(state.status).toBe(429);
      expect(state.headers['retry-after']).toBe('17');
      expect(state.body).toEqual({
        code: 'TOO_MANY_REQUESTS',
        message,
        error: message,
        rateLimit: RATE_LIMIT,
      });
    }
  );

  it.each(ROUTES)(
    'INVARIANT GUARD: $name: a 429 whose cause carries no rateLimit keeps its old body',
    async ({ name, handler, body, mock, message }) => {
      mock.mockRejectedValueOnce(refusal(message, {}));
      const { req, res, state } = createMocks(body);

      await handler(req as never, res as never);

      expect(state.status).toBe(429);
      expect(state.headers['retry-after']).toBeUndefined();
      expect(state.body).toEqual(name === 'increment' ? { error: message } : { message });
    }
  );

  it.each(ROUTES)(
    'INVARIANT GUARD: $name: a non-rate-limit 4xx keeps its old body',
    async ({ name, handler, body, mock }) => {
      mock.mockRejectedValueOnce(
        new TRPCError({ code: 'NOT_FOUND', message: 'request not found' })
      );
      const { req, res, state } = createMocks(body);

      await handler(req as never, res as never);

      expect(state.status).toBe(404);
      expect(state.headers['retry-after']).toBeUndefined();
      expect(state.body).toEqual(
        name === 'increment' ? { error: 'request not found' } : { message: 'request not found' }
      );
    }
  );
});

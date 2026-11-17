import { EventEmitter } from 'events';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '~/server/auth/get-server-auth-session';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `/api/mod/retracted-media` through the REAL `ModEndpoint`: anyone but a moderator on a session (or
 * a full-scope key) is turned away before anything is read, and the refusal still says no-store.
 */

const session = vi.hoisted(() => ({ value: null as unknown }));
const getRetractedMedia = vi.hoisted(() => vi.fn());

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  getServerAuthSession: async () => session.value,
}));
vi.mock('~/server/services/retracted-media.service', () => ({
  getRetractedMedia,
  NEEDS_CSAM_QUEUE: 'needs-csam-queue',
}));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlagsAsync: async () => ({ modRetractedMedia: true }),
}));
vi.mock('~/server/utils/public-api-rate-limit', () => ({
  checkFixedWindow: async () => ({ allowed: true }),
}));

const { default: media } = await import('~/pages/api/mod/retracted-media/[imageId]');

function fakeRes() {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    getHeader: (name: string) => res.headers[name.toLowerCase()],
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json: () => res,
    end: () => res,
  });
  return res;
}

async function send(extra: { headers?: Record<string, string>; context?: unknown } = {}) {
  const req = Object.assign(new EventEmitter(), {
    method: 'GET',
    url: '/api/mod/retracted-media/7',
    query: { imageId: '7' },
    headers: extra.headers ?? {},
    context: extra.context,
  }) as unknown as NextApiRequest;
  const res = fakeRes();
  await media(req, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  getRetractedMedia.mockResolvedValue(null);
});

describe('retracted-media is moderator-only', () => {
  it.each([
    ['no session', null],
    ['a member', { user: { id: 5, isModerator: false } }],
    ['a banned moderator', { user: { id: 5, isModerator: true, bannedAt: new Date() } }],
  ])('refuses %s with no-store, before reading anything', async (_name, value) => {
    session.value = value;
    const res = await send();
    expect(res.statusCode).toBe(401);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(getRetractedMedia).not.toHaveBeenCalled();
  });

  it('refuses a moderator on a narrow-scope API key with no-store', async () => {
    session.value = { user: { id: 5, isModerator: true } };
    const res = await send({
      headers: { authorization: 'Bearer k' },
      context: { apiKeyId: 1, tokenScope: TokenScope.UserRead },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(getRetractedMedia).not.toHaveBeenCalled();
  });

  // The control: a moderator on a session gets past the wrapper, so the refusals above are its.
  it('lets a moderator on a session through to the handler', async () => {
    session.value = { user: { id: 5, isModerator: true } };
    const res = await send();
    expect(res.statusCode).toBe(404);
    // The handler's own answers rely on the real wrapper's no-store too, not only its refusals.
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(getRetractedMedia).toHaveBeenCalledWith(7, { csamReview: false });
  });
});

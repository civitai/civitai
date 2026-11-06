import { EventEmitter } from 'events';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '~/server/auth/get-server-auth-session';
import type * as FlagsModule from '~/server/services/feature-flags.service';

/**
 * Both held-media routes through the REAL `ModEndpoint`, which their other tests replace: a session
 * that is not a moderator is turned away before the handler runs, so nothing is read or served.
 */

const session = vi.hoisted(() => ({ value: null as unknown }));
const getHeldMedia = vi.hoisted(() => vi.fn());

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  getServerAuthSession: async () => session.value,
}));
vi.mock('~/server/services/held-media.service', () => ({ getHeldMedia }));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FlagsModule>()),
  getFeatureFlags: () => ({ csamReports: true }),
}));

const { default: media } = await import('~/pages/api/mod/held-media/[imageId]');
const { default: gridView } = await import('~/pages/api/mod/held-media/grid-view');
const { default: shown } = await import('~/pages/api/mod/held-media/shown');

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

const send = async (handler: typeof media, method: string, body?: unknown) => {
  const req = Object.assign(new EventEmitter(), {
    method,
    url: '/api/mod/held-media/7',
    query: { imageId: '7' },
    headers: {},
    body,
  }) as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res as unknown as NextApiResponse);
  return res.statusCode;
};

beforeEach(() => vi.clearAllMocks());

describe('held-media routes are moderator-only', () => {
  it.each([
    ['no session', null],
    ['a member', { user: { id: 5, isModerator: false } }],
    ['a banned moderator', { user: { id: 5, isModerator: true, bannedAt: new Date() } }],
  ])('refuses %s on every route, before reading anything', async (_name, value) => {
    session.value = value;
    expect(await send(media, 'GET')).toBe(401);
    expect(await send(gridView, 'POST', { count: 1, userId: 9 })).toBe(401);
    expect(
      await send(shown, 'POST', { imageId: 7, userId: 9, action: 'select', rendition: 'original' })
    ).toBe(401);
    expect(getHeldMedia).not.toHaveBeenCalled();
  });

  // The control: the same requests as a moderator get past the wrapper, so the 401s above are its.
  it('lets a moderator through to the handler', async () => {
    session.value = { user: { id: 5, isModerator: true } };
    getHeldMedia.mockResolvedValue(null);
    expect(await send(media, 'GET')).not.toBe(401);
    expect(getHeldMedia).toHaveBeenCalledWith(7);
  });
});

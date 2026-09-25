import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';

/**
 * The service worker's `pushsubscriptionchange` route. Covers the two things that make it more
 * than a second copy of `notification.subscribePush`: it reaps the endpoint the push service
 * rotated away from, and it must do so AFTER the upsert (see the ordering test for why).
 *
 * `AuthedEndpoint` is unwrapped rather than exercised — this lane is about the handler body; the
 * session gate is the wrapper's own contract and is covered where that wrapper is tested.
 */
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  AuthedEndpoint: (handler: unknown) => handler,
}));

const { upsertPushSubscription, deletePushSubscription, calls } = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    upsertPushSubscription: vi.fn(async () => {
      calls.push('upsert');
    }),
    deletePushSubscription: vi.fn(async () => {
      calls.push('delete');
    }),
  };
});

vi.mock('~/server/services/notification.service', () => ({
  upsertPushSubscription,
  deletePushSubscription,
}));

const handler = (await import('~/pages/api/push/resubscribe')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
) => Promise<void>;

const USER = { id: 42, username: 'u', email: 'u@x.test' } as SessionUser;
const ENDPOINT = 'https://push.test/new';
const KEYS = { p256dh: 'p', auth: 'a' };

async function post(body: unknown, user: SessionUser = USER) {
  let statusCode = 0;
  let payload: unknown;
  const req = {
    method: 'POST',
    body,
    headers: { 'user-agent': 'TestBrowser/1.0' },
    query: {},
  } as unknown as NextApiRequest;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
      return res;
    },
  } as unknown as NextApiResponse;
  await handler(req, res, user);
  return { statusCode, payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
});

describe('POST /api/push/resubscribe', () => {
  it('upserts the new subscription against the session user', async () => {
    const { statusCode } = await post({ endpoint: ENDPOINT, keys: KEYS });

    expect(statusCode).toBe(200);
    expect(upsertPushSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: ENDPOINT, userId: 42, userAgent: 'TestBrowser/1.0' })
    );
  });

  it('deletes the rotated-away endpoint, scoped to the session user', async () => {
    await post({ endpoint: ENDPOINT, keys: KEYS, oldEndpoint: 'https://push.test/old' });

    // userId comes from the session, never the body — the caller cannot name someone else's row.
    expect(deletePushSubscription).toHaveBeenCalledWith({
      endpoint: 'https://push.test/old',
      userId: 42,
    });
  });

  it('deletes the old endpoint only AFTER the upsert', async () => {
    await post({ endpoint: ENDPOINT, keys: KEYS, oldEndpoint: 'https://push.test/old' });

    // Load-bearing ordering, not an aesthetic choice. `upsertPushSubscription` materializes the
    // DEFAULT_PUSH_TYPES rows only while the user holds zero subscriptions. Delete first and a
    // rotating browser that held exactly one subscription looks brand new, so every push type the
    // user had since turned off is silently re-created — invariant 3 in docs/features/web-push.md.
    expect(calls).toEqual(['upsert', 'delete']);
  });

  it('does not delete anything when no old endpoint is supplied', async () => {
    await post({ endpoint: ENDPOINT, keys: KEYS });
    expect(deletePushSubscription).not.toHaveBeenCalled();
  });

  it('does not delete the row it just wrote when old and new endpoints match', async () => {
    await post({ endpoint: ENDPOINT, keys: KEYS, oldEndpoint: ENDPOINT });

    expect(upsertPushSubscription).toHaveBeenCalledTimes(1);
    expect(deletePushSubscription).not.toHaveBeenCalled();
  });

  it('rejects a non-https endpoint without touching the database', async () => {
    const { statusCode } = await post({ endpoint: 'http://push.test/new', keys: KEYS });

    expect(statusCode).toBe(400);
    expect(upsertPushSubscription).not.toHaveBeenCalled();
    expect(deletePushSubscription).not.toHaveBeenCalled();
  });

  it('rejects a body with no keys', async () => {
    const { statusCode } = await post({ endpoint: ENDPOINT });

    expect(statusCode).toBe(400);
    expect(upsertPushSubscription).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';

/**
 * `/api/notification/getDetails` enriches a notification with the CONTENT of whatever it points at —
 * a comment body and its author, a review's text. The caller posts the notification, so if the
 * endpoint trusts that payload, any authenticated user can read content by id, including from threads
 * they cannot open (an unpublished model's, a cohort-gated app listing's).
 *
 * The fix is that the posted body is treated as a claim, not evidence: the endpoint looks the
 * notification up among the caller's own and enriches the stored row. These tests fail if that lookup
 * is removed OR if the posted `details` are ever passed through in place of the stored ones.
 */

const queryNotifications = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []);
const populateNotificationDetails = vi.fn(async (..._a: unknown[]) => undefined);

vi.mock('~/server/notifications/client', () => ({ notifications: { queryNotifications } }));
vi.mock('~/server/notifications/detail-fetchers', () => ({ populateNotificationDetails }));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/utils/endpoint-helpers')>()),
  // Unwrap the auth wrapper: the session is not what is under test, the ownership check is.
  AuthedEndpoint: (handler: unknown) => handler,
}));

const handler = (await import('~/pages/api/notification/getDetails')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
) => Promise<void>;

const USER = { id: 7 } as SessionUser;
const OWN = {
  id: 1,
  type: 'new-comment',
  category: 'Comment',
  details: { commentId: 500, version: 2 },
  createdAt: new Date(),
  read: false,
};

/** Minimal req/res pair. `node-mocks-http` is not a dependency here; the sibling REST-envelope suite
 *  hand-rolls the same shape for the same reason. */
const post = (body: unknown) => {
  const req = { method: 'POST', url: '/api/test', headers: {}, query: {}, body } as NextApiRequest;
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
      return res;
    },
    setHeader: () => res,
  } as unknown as NextApiResponse & { statusCode: number; payload: unknown };

  return {
    promise: handler(req, res, USER),
    status: () => statusCode,
    payload: () => payload,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  queryNotifications.mockResolvedValue([OWN]);
});

describe('POST /api/notification/getDetails', () => {
  it('refuses a notification that is not the caller’s', async () => {
    const call = post({ id: 999, type: 'new-comment', details: { commentId: 12345 } });
    await call.promise;

    expect(call.status()).toBe(404);
    // The important half: nothing was fetched for the id the caller supplied.
    expect(populateNotificationDetails).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the calling user', async () => {
    await post({ id: 1, type: 'new-comment', details: {} }).promise;

    expect(queryNotifications).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }));
  });

  it('enriches the STORED details, never the posted ones', async () => {
    // A caller naming their own notification id, with someone else's comment id in the body.
    await post({ id: 1, type: 'new-comment', details: { commentId: 999999, version: 2 } }).promise;

    expect(populateNotificationDetails).toHaveBeenCalledWith([
      { id: 1, type: 'new-comment', details: { commentId: 500, version: 2 } },
    ]);
  });

  it('rejects a body that is not a notification at all', async () => {
    const call = post({ nope: true });
    await call.promise;

    expect(call.status()).toBe(400);
    expect(queryNotifications).not.toHaveBeenCalled();
  });
});

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

/**
 * Every fixture above spells the id as a JSON number, which is what the types say and NOT what travels.
 * The id column is 64-bit and the notifications service serializes 64-bit integers as decimal strings,
 * both in the signal the browser forwards to this endpoint and in the rows `queryNotifications`
 * returns. The endpoint demanded a number, so it answered 400 to every request a real client made, and
 * behind that it compared the posted id to the stored one with `===`, which a string never satisfies.
 *
 * These fixtures are the wire shape. The id is deliberately past 2^31: a value the number-only schema
 * cannot have been handed by a 32-bit column.
 */
describe('POST /api/notification/getDetails — ids as they arrive on the wire', () => {
  const WIRE_ID = '2421362569';
  const STORED = { ...OWN, id: WIRE_ID, details: { commentId: 731, version: 2 } };
  /** What the signal carries, forwarded unchanged by the client. */
  const signalled = (id: unknown) => ({
    type: 'new-comment',
    category: 'Comment',
    details: { commentId: 731, version: 2 },
    id,
    createdAt: '2026-10-12T16:00:00.000Z',
    read: false,
  });

  beforeEach(() => {
    queryNotifications.mockResolvedValue([OWN, STORED]);
  });

  it('enriches a notification whose id arrives as a decimal string', async () => {
    const call = post(signalled(WIRE_ID));
    await call.promise;

    expect(call.status(), 'a well-formed signal payload must not be refused').toBe(200);
    expect(populateNotificationDetails).toHaveBeenCalledWith([
      { id: WIRE_ID, type: 'new-comment', details: { commentId: 731, version: 2 } },
    ]);
  });

  it('matches a numeric posted id against a string stored id', async () => {
    const call = post(signalled(2421362569));
    await call.promise;

    expect(call.status()).toBe(200);
    expect(populateNotificationDetails).toHaveBeenCalledTimes(1);
  });

  it('needs nothing but the id — the rest of the body is never read', async () => {
    const call = post({ id: WIRE_ID });
    await call.promise;

    expect(call.status()).toBe(200);
  });

  it('matches a string posted id against a numeric stored id', async () => {
    queryNotifications.mockResolvedValue([{ ...STORED, id: 2421362569 }]);
    const call = post(signalled(WIRE_ID));
    await call.promise;

    expect(call.status()).toBe(200);
    expect(populateNotificationDetails).toHaveBeenCalledTimes(1);
  });

  it('reads leading zeros as the same id — it can only ever resolve among the caller’s own', async () => {
    const call = post(signalled('0' + WIRE_ID));
    await call.promise;

    expect(call.status()).toBe(200);
    expect(populateNotificationDetails).toHaveBeenCalledWith([
      { id: WIRE_ID, type: 'new-comment', details: { commentId: 731, version: 2 } },
    ]);
  });

  it('reads stored ids with the same grammar as posted ones, not with a looser coercion', async () => {
    // Each decoy is a value `Number()` would equate to the posted id but that is not an id, and each
    // sits before the real row — so a lookup that coerced loosely would enrich the decoy's details.
    queryNotifications.mockResolvedValue([
      { ...STORED, id: `${WIRE_ID}.0`, details: { commentId: 1 } },
      { ...STORED, id: ` ${WIRE_ID}`, details: { commentId: 2 } },
      STORED,
    ]);
    const call = post(signalled(WIRE_ID));
    await call.promise;

    expect(call.status()).toBe(200);
    expect(populateNotificationDetails).toHaveBeenCalledWith([
      { id: WIRE_ID, type: 'new-comment', details: { commentId: 731, version: 2 } },
    ]);
  });

  it.each([
    ['null', null],
    ['a string', WIRE_ID],
    ['an array', [WIRE_ID]],
  ])('rejects a body that is %s', async (_name, body) => {
    const call = post(body);
    await call.promise;

    expect(call.status()).toBe(400);
    expect(queryNotifications).not.toHaveBeenCalled();
  });

  it('still answers 404 for a string id that is not the caller’s', async () => {
    const call = post(signalled('2421362570'));
    await call.promise;

    expect(call.status()).toBe(404);
    expect(populateNotificationDetails).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['blank', ' '],
    ['signed', '-1'],
    ['plus-signed', '+12'],
    ['leading space', ' 12'],
    ['trailing space', '12 '],
    ['negative number', -1],
    ['zero number', 0],
    ['unsafe number', Number.MAX_SAFE_INTEGER + 2],
    ['fractional', '1.5'],
    ['exponent', '1e3'],
    ['hex', '0x10'],
    ['word', 'abc'],
    ['zero', '0'],
    ['beyond exact integer range', '9007199254740993'],
    ['null', null],
    ['boolean', true],
    ['array', [1]],
    ['fractional number', 1.5],
  ])('rejects an id that is not one: %s', async (_name, id) => {
    const call = post(signalled(id));
    await call.promise;

    expect(call.status()).toBe(400);
    expect(queryNotifications).not.toHaveBeenCalled();
  });
});

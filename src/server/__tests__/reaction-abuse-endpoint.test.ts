import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeratorService from '~/server/services/moderator.service';
// Imported for the side effect: these install the canonical mocks the endpoint's module-scope
// imports would otherwise reach for real.
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';

// `~/env/server` is NOT mocked here. The canonical worker-level mock (src/__tests__/setup.ts →
// TEST_ENV_DEFAULTS) already supplies WEBHOOK_TOKEN, and it has to: `WebhookEndpoint` reads it at
// MODULE SCOPE, so a per-file factory is too late — and a thin hand-rolled `env` drops
// TRPC_ORIGINS/NEXTAUTH_URL, which endpoint-helpers spreads at load. That failure reports as
// `Tests no tests` (a collection error), not as a red assertion.
const TOKEN = 'test-webhook-token';

const { insert, chQuery, trackModActivity, logToAxiom } = vi.hoisted(() => ({
  insert: vi.fn(async () => undefined),
  chQuery: vi.fn(async () => [] as unknown[]),
  trackModActivity: vi.fn(async () => undefined),
  logToAxiom: vi.fn(),
}));

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom }));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { insert, $query: chQuery },
}));

// Only the audit write is stubbed — the handler's own decision about WHEN to call it, with WHICH
// sentinel and WHICH activity, stays real. That is the whole of what this change added.
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity,
}));

const handler = (await import('~/pages/api/admin/reaction-abuse')).default;

function createMocks(body: Record<string, unknown>) {
  const req = {
    method: 'POST',
    query: { token: TOKEN },
    body,
    headers: {},
  } as unknown as NextApiRequest;

  let statusCode = 0;
  let payload: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: unknown) {
      payload = data;
      return res;
    },
    send(data: unknown) {
      payload = data;
      return res;
    },
    setHeader: () => res,
    end: () => res,
    _status: () => statusCode,
    _body: () => payload as Record<string, unknown>,
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

beforeEach(() => {
  insert.mockClear();
  chQuery.mockClear();
  trackModActivity.mockClear();
  logToAxiom.mockClear();
  insert.mockImplementation(async () => undefined);
  trackModActivity.mockImplementation(async () => undefined);
});

describe('POST /api/admin/reaction-abuse — mod-action audit trail', () => {
  it('records a reactionAbuseExclude row for every excluded user', async () => {
    const { req, res } = createMocks({
      action: 'exclude',
      userIds: [111, 222, 333],
      reason: '[agent conf=0.94] ring of 9 on /24, 0.81 concentration',
    });

    await handler(req, res);

    expect(res._status()).toBe(200);
    // The sentinel and the activity name are both asserted literally: `-1` is what the moderator
    // app's `userId > 0` board filter relies on to keep a cron out of the "who last worked this
    // queue" panel, and the activity string is the exact value its query selects on.
    expect(trackModActivity).toHaveBeenCalledTimes(1);
    expect(trackModActivity).toHaveBeenCalledWith(-1, {
      entityType: 'user',
      entityId: [111, 222, 333],
      activity: 'reactionAbuseExclude',
    });
    expect(res._body()).toMatchObject({ excluded: 3, auditRecorded: true });
  });

  it('records a distinct activity for unexclude, so a reversal is not indistinguishable from the action', async () => {
    const { req, res } = createMocks({ action: 'unexclude', userIds: [444] });

    await handler(req, res);

    expect(res._status()).toBe(200);
    expect(trackModActivity).toHaveBeenCalledWith(-1, {
      entityType: 'user',
      entityId: [444],
      activity: 'reactionAbuseUnexclude',
    });
    expect(res._body()).toMatchObject({ unexcluded: 1, auditRecorded: true });
  });

  // `unexclude` has no automated caller — it is a human reversing a false positive. Attributing that
  // to the system sentinel is the defect this pair exists to prevent.
  it.each([
    ['unexclude', {}],
    ['exclude', { reason: 'r' }],
  ] as const)(
    'attributes %s to the moderator when the caller asserts one',
    async (action, extra) => {
      const { req, res } = createMocks({ action, userIds: [888], actorUserId: 4242, ...extra });

      await handler(req, res);

      expect(res._status()).toBe(200);
      expect(trackModActivity).toHaveBeenCalledWith(
        4242,
        expect.objectContaining({ entityId: [888] })
      );
    }
  );

  it.each([
    ['exclude', { reason: 'r' }],
    ['unexclude', {}],
  ] as const)(
    'writes the %s audit row only AFTER the ClickHouse write has actually landed',
    async (action, extra) => {
      const order: string[] = [];
      insert.mockImplementation(async () => {
        order.push('clickhouse');
      });
      trackModActivity.mockImplementation(async () => {
        order.push('audit');
      });

      const { req, res } = createMocks({ action, userIds: [555], ...extra });
      await handler(req, res);

      // An audit row for a write that never landed is a false record of a moderation action.
      expect(order).toEqual(['clickhouse', 'audit']);
    }
  );

  it.each([
    ['exclude', { reason: 'r' }],
    ['unexclude', {}],
  ] as const)(
    'does NOT write an audit row when the %s write itself fails',
    async (action, extra) => {
      insert.mockRejectedValueOnce(new Error('clickhouse down'));

      const { req, res } = createMocks({ action, userIds: [666], ...extra });
      await handler(req, res);

      expect(res._status()).toBe(500);
      expect(trackModActivity).not.toHaveBeenCalled();
    }
  );

  it('reports a failed audit write instead of masking it, and still returns the applied exclusion', async () => {
    trackModActivity.mockRejectedValueOnce(new Error('pg down'));

    const { req, res } = createMocks({ action: 'exclude', userIds: [777], reason: 'r' });
    await handler(req, res);

    // 200, because the exclusion DID apply — a 500 here would tell the caller nothing happened and
    // invite a retry that re-inserts. `auditRecorded: false` is how it learns the trail has a hole,
    // which is the failure mode this whole trail exists to remove.
    expect(res._status()).toBe(200);
    expect(res._body()).toMatchObject({ excluded: 1, auditRecorded: false });
  });

  // The response field is inert until a caller branches on it, so the log is the signal that works
  // today. Pinned because deleting it left every other test in this file green.
  it('reports a failed audit write to Axiom, not just in the response body', async () => {
    trackModActivity.mockRejectedValueOnce(new Error('pg down'));

    const { req, res } = createMocks({ action: 'exclude', userIds: [777], reason: 'r' });
    await handler(req, res);

    expect(logToAxiom).toHaveBeenCalledTimes(1);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'reaction-abuse audit write failed',
        message: 'pg down',
      }),
      'moderation'
    );
  });

  it('does not log to Axiom when the audit write succeeds', async () => {
    const { req, res } = createMocks({ action: 'exclude', userIds: [999], reason: 'r' });
    await handler(req, res);

    expect(res._status()).toBe(200);
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  // Named for all three read-only actions and now exercising all three — the previous version said
  // "actions" and checked only `list`.
  it.each([
    ['list', {}],
    ['candidates', {}],
    ['inspect-owner', { ownerId: 12 }],
  ] as const)('leaves the read-only action %s unaudited', async (action, extra) => {
    const { req, res } = createMocks({ action, ...extra });

    await handler(req, res);

    expect(res._status()).toBe(200);
    expect(trackModActivity).not.toHaveBeenCalled();
  });
});

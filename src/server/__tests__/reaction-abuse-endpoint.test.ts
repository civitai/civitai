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

const { insert, chQuery, trackModActivity } = vi.hoisted(() => ({
  insert: vi.fn(async () => undefined),
  chQuery: vi.fn(async () => [] as unknown[]),
  trackModActivity: vi.fn(async () => undefined),
}));

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
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
  trackModActivity.mockImplementation(async () => undefined);
});

describe('POST /api/admin/reaction-abuse — automated-action audit trail', () => {
  it('records an autoExcludeReactionAbuse row for every excluded user', async () => {
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
      activity: 'autoExcludeReactionAbuse',
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
      activity: 'autoUnexcludeReactionAbuse',
    });
    expect(res._body()).toMatchObject({ unexcluded: 1, auditRecorded: true });
  });

  it('writes the audit row only AFTER the exclusion has actually been committed', async () => {
    const order: string[] = [];
    insert.mockImplementation(async () => {
      order.push('clickhouse');
    });
    trackModActivity.mockImplementation(async () => {
      order.push('audit');
    });

    const { req, res } = createMocks({ action: 'exclude', userIds: [555], reason: 'r' });
    await handler(req, res);

    // An audit row for an exclusion that never landed is a false record of a moderation action.
    expect(order).toEqual(['clickhouse', 'audit']);
  });

  it('does NOT write an audit row when the exclusion itself fails', async () => {
    insert.mockRejectedValueOnce(new Error('clickhouse down'));

    const { req, res } = createMocks({ action: 'exclude', userIds: [666], reason: 'r' });
    await handler(req, res);

    expect(res._status()).toBe(500);
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('reports a failed audit write instead of masking it, and still returns the applied exclusion', async () => {
    trackModActivity.mockRejectedValueOnce(new Error('pg down'));

    const { req, res } = createMocks({ action: 'exclude', userIds: [777], reason: 'r' });
    await handler(req, res);

    // 200, because the exclusion DID apply — a 500 here would tell the poller nothing happened and
    // invite a retry that double-writes the audit row. `auditRecorded: false` is how the caller
    // learns the trail has a hole, which is the failure mode this whole trail exists to remove.
    expect(res._status()).toBe(200);
    expect(res._body()).toMatchObject({ excluded: 1, auditRecorded: false });
  });

  it('leaves the read-only actions unaudited', async () => {
    const { req, res } = createMocks({ action: 'list' });

    await handler(req, res);

    expect(res._status()).toBe(200);
    expect(trackModActivity).not.toHaveBeenCalled();
  });
});

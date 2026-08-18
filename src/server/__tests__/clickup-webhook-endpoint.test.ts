import crypto from 'crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BugService from '~/server/services/bug.service';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';

const SECRET = 'clickup-test-signing-secret';
const TASK_ID = '868kfwm3j';

// vi.hoisted: vi.mock factories run before module-level consts exist. Mutable so
// the "not configured" case can unset the secret without re-importing.
const { env, resolveBugsByClickupTaskId } = vi.hoisted(() => ({
  // LOGGING: read at import time by createLogger, which bug.service pulls in
  // transitively through cache-helpers.
  env: { CLICKUP_WEBHOOK_SECRET: 'clickup-test-signing-secret', LOGGING: '' } as {
    CLICKUP_WEBHOOK_SECRET?: string;
    LOGGING: string;
  },
  resolveBugsByClickupTaskId: vi.fn(async () => ({ matched: [1], resolved: [], skipped: [] })),
}));
vi.mock('~/env/server', () => ({ env }));

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));

// Only the write is stubbed — `clickupDoneStatusFromPayload` stays real, so these
// cases exercise the handler's actual decision about what counts as a completion.
vi.mock('~/server/services/bug.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BugService>()),
  resolveBugsByClickupTaskId,
}));

const handler = (await import('~/pages/api/webhooks/clickup')).default;

const sign = (body: string, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');

function createMocks(body: string, headers: Record<string, string>) {
  const req = Readable.from([body]) as unknown as Record<string, unknown>;
  req.method = 'POST';
  req.headers = headers;

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
    _body: () => payload,
  };
  return { req, res };
}

const completion = JSON.stringify({
  event: 'taskStatusUpdated',
  task_id: TASK_ID,
  history_items: [{ field: 'status', after: { status: 'complete', type: 'closed' } }],
});

const run = (body: string, signature?: string) => {
  const { req, res } = createMocks(body, signature ? { 'x-signature': signature } : {});
  return handler(req as never, res as never).then(() => res);
};

beforeEach(() => {
  vi.clearAllMocks();
  env.CLICKUP_WEBHOOK_SECRET = SECRET;
});

describe('clickup webhook endpoint', () => {
  it('closes the linked entry when a correctly signed completion arrives', async () => {
    const res = await run(completion, sign(completion));

    expect(res._status()).toBe(200);
    expect(resolveBugsByClickupTaskId).toHaveBeenCalledWith({ taskId: TASK_ID });
  });

  it('rejects a body whose signature does not match it', async () => {
    // Correctly signed — for a DIFFERENT body. This is the forgery case: a valid
    // signature is not a licence to act on whatever payload accompanies it.
    const res = await run(completion, sign('{"event":"taskStatusUpdated"}'));

    expect(res._status()).toBe(401);
    expect(resolveBugsByClickupTaskId).not.toHaveBeenCalled();
  });

  it('rejects an unsigned request', async () => {
    const res = await run(completion);

    expect(res._status()).toBe(401);
    expect(resolveBugsByClickupTaskId).not.toHaveBeenCalled();
  });

  it('refuses to serve at all when no signing secret is configured', async () => {
    env.CLICKUP_WEBHOOK_SECRET = undefined;

    const res = await run(completion, sign(completion));

    expect(res._status()).toBe(503);
    expect(resolveBugsByClickupTaskId).not.toHaveBeenCalled();
  });

  it('acks a signed status change that is not a completion without touching the board', async () => {
    const body = JSON.stringify({
      event: 'taskStatusUpdated',
      task_id: TASK_ID,
      history_items: [{ field: 'status', after: { status: 'in progress', type: 'custom' } }],
    });

    const res = await run(body, sign(body));

    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ ignored: 'taskStatusUpdated' });
    expect(resolveBugsByClickupTaskId).not.toHaveBeenCalled();
  });
});

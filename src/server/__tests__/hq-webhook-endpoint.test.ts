import { Readable } from 'node:stream';
import { Webhook } from 'standardwebhooks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as BugService from '~/server/services/bug.service';

// Standard Webhooks secrets are `whsec_` + base64 of the key bytes.
const SECRET = `whsec_${Buffer.from('hq-test-signing-secret').toString('base64')}`;
const OTHER_SECRET = `whsec_${Buffer.from('some-other-secret').toString('base64')}`;
const TASK_ID = '868kfwm3j';

const { resolveBugsByClickupTaskId } = vi.hoisted(() => ({
  resolveBugsByClickupTaskId: vi.fn(async () => ({
    matched: [1],
    resolved: [{ id: 1, previousStatus: 'Open' }],
    skipped: [],
    failed: [],
  })),
}));

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));

// Only the write is stubbed, so these cases exercise the handler's own decisions.
vi.mock('~/server/services/bug.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BugService>()),
  resolveBugsByClickupTaskId,
}));

const handler = (await import('~/pages/api/webhooks/hq')).default;

const envelope = (status: string, type = 'task.closed') =>
  JSON.stringify({
    type,
    timestamp: new Date().toISOString(),
    data: {
      task_id: TASK_ID,
      status,
      closed: new Date().toISOString(),
      url: `https://tasks.example.test/t/${TASK_ID}`,
    },
  });

const signedHeaders = (
  body: string,
  { id = 'msg_1', at = new Date(), secret = SECRET } = {}
): Record<string, string> => ({
  'webhook-id': id,
  'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
  'webhook-signature': new Webhook(secret).sign(id, at, body),
});

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

const run = (body: string, headers: Record<string, string>) => {
  const { req, res } = createMocks(body, headers);
  return handler(req as never, res as never).then(() => res);
};

// In-memory keys, so a replay is suppressed by the handler's real dedupe logic.
const processed = new Set<string>();

beforeEach(() => {
  vi.clearAllMocks();
  processed.clear();
  envMock.set({ HQ_WEBHOOK_SECRET: SECRET });
  redisMock.sysRedis.exists.mockImplementation(async (key: string) => Number(processed.has(key)));
  redisMock.sysRedis.set.mockImplementation(async (key: string) => {
    processed.add(key);
    return 'OK';
  });
});

describe('hq webhook endpoint', () => {
  it('resolves the linked entry when a correctly signed completion arrives', async () => {
    const body = envelope('complete');

    const res = await run(body, signedHeaders(body));

    expect(res._status()).toBe(200);
    expect(resolveBugsByClickupTaskId).toHaveBeenCalledWith({ taskId: TASK_ID });
  });

  it('accepts a delivery carrying an extra signature during secret rotation', async () => {
    const body = envelope('complete');
    const headers = signedHeaders(body);
    const stale = signedHeaders(body, { secret: OTHER_SECRET })['webhook-signature'];
    headers['webhook-signature'] = `${stale} ${headers['webhook-signature']}`;

    const res = await run(body, headers);

    expect(res._status()).toBe(200);
    expect(resolveBugsByClickupTaskId).toHaveBeenCalledTimes(1);
  });

  it('rejects a body signed with a different secret', async () => {
    const body = envelope('complete');

    const res = await run(body, signedHeaders(body, { secret: OTHER_SECRET }));

    expect(res._status()).toBe(401);
    expect(resolveBugsByClickupTaskId).not.toHaveBeenCalled();
  });

  it('rejects a body whose signature was made for a different body', async () => {
    const body = envelope('complete');

    const res = await run(body, signedHeaders(envelope('wontfix')));

    expect(res._status()).toBe(401);
    expect(resolveBugsByClickupTaskId).not.toHaveBeenCalled();
  });

  it('rejects an unsigned request', async () => {
    const res = await run(envelope('complete'), {});

    expect(res._status()).toBe(401);
    expect(resolveBugsByClickupTaskId).not.toHaveBeenCalled();
  });

  it('rejects a correctly signed delivery older than five minutes', async () => {
    const body = envelope('complete');
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);

    const res = await run(body, signedHeaders(body, { at: sixMinutesAgo }));

    expect(res._status()).toBe(401);
    expect(resolveBugsByClickupTaskId).not.toHaveBeenCalled();
  });

  // A task closed as wontfix is closed, but the issue it tracks was not fixed.
  it('acks a task closed as wontfix without resolving anything', async () => {
    const body = envelope('wontfix');

    const res = await run(body, signedHeaders(body));

    expect(res._status()).toBe(200);
    expect(res._body()).toEqual({ ignored: 'wontfix' });
    expect(resolveBugsByClickupTaskId).not.toHaveBeenCalled();
  });

  it('acks an event type it does not handle, whatever its data looks like', async () => {
    const body = JSON.stringify({ type: 'task.created', data: { id: 42, title: 'x' } });

    const res = await run(body, signedHeaders(body));

    expect(res._status()).toBe(200);
    expect(resolveBugsByClickupTaskId).not.toHaveBeenCalled();
  });

  it('treats a replay of the same delivery id as a no-op', async () => {
    const body = envelope('complete');
    const headers = signedHeaders(body, { id: 'msg_replayed' });

    const first = await run(body, headers);
    const second = await run(body, headers);

    expect(first._status()).toBe(200);
    expect(second._status()).toBe(200);
    expect(second._body()).toEqual({ duplicate: true, taskId: TASK_ID });
    expect(resolveBugsByClickupTaskId).toHaveBeenCalledTimes(1);
  });

  it('processes a new delivery for the same task, as after a reopen and close', async () => {
    const body = envelope('complete');

    await run(body, signedHeaders(body, { id: 'msg_first_close' }));
    await run(body, signedHeaders(body, { id: 'msg_second_close' }));

    expect(resolveBugsByClickupTaskId).toHaveBeenCalledTimes(2);
  });

  it('answers 5xx when resolving fails, and processes the retry of that delivery', async () => {
    resolveBugsByClickupTaskId.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
    const body = envelope('complete');
    const headers = signedHeaders(body, { id: 'msg_retried' });

    const failed = await run(body, headers);
    const retried = await run(body, headers);

    expect(failed._status()).toBe(500);
    expect(String(failed._body())).not.toContain('ETIMEDOUT');
    expect(retried._status()).toBe(200);
    expect(resolveBugsByClickupTaskId).toHaveBeenCalledTimes(2);
  });

  it('answers 5xx when an entry fails to close, and the retry runs again', async () => {
    resolveBugsByClickupTaskId.mockResolvedValueOnce({
      matched: [1, 2],
      resolved: [{ id: 1, previousStatus: 'Open' }],
      skipped: [],
      failed: [{ id: 2, error: 'lock timeout' }],
    });
    const body = envelope('complete');
    const headers = signedHeaders(body, { id: 'msg_partial' });

    const partial = await run(body, headers);
    const retried = await run(body, headers);

    expect(partial._status()).toBe(500);
    expect(retried._status()).toBe(200);
    expect(resolveBugsByClickupTaskId).toHaveBeenCalledTimes(2);
  });

  it('answers 5xx without resolving when the dedupe check fails', async () => {
    redisMock.sysRedis.exists.mockRejectedValueOnce(new Error('redis down'));
    const body = envelope('complete');

    const res = await run(body, signedHeaders(body));

    expect(res._status()).toBe(500);
    expect(resolveBugsByClickupTaskId).not.toHaveBeenCalled();
  });

  it('refuses to serve at all when no signing secret is configured', async () => {
    envMock.set({ HQ_WEBHOOK_SECRET: undefined });
    const body = envelope('complete');

    const res = await run(body, signedHeaders(body));

    expect(res._status()).toBe(503);
    expect(resolveBugsByClickupTaskId).not.toHaveBeenCalled();
  });
});

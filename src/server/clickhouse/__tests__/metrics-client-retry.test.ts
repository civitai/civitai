import http from 'node:http';
import type { AddressInfo } from 'node:net';
import client from 'prom-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClickhouseMetricsClient } from '~/server/clickhouse/metrics-client';

// The dedicated metrics client's one-shot retry on a connection-level error, run through the REAL
// clickhouse-js client (the factory production uses) against a local HTTP server that misbehaves
// on cue. The server is the only fake: the error shapes asserted here are the ones Node and
// clickhouse-js actually produce for each failure.

type Behaviour =
  | 'ok'
  // TCP RST before any response: `read ECONNRESET`.
  | 'reset'
  // Socket closed before any response: `socket hang up` (code ECONNRESET).
  | 'hangup'
  // Headers and one row sent, then RST: the body read fails with `aborted` (code ECONNRESET).
  | 'reset-mid-body'
  // ClickHouse's max_execution_time error, as the server sends it.
  | 'server-timeout'
  // A server-side error that is not a timeout.
  | 'unknown-table'
  // No response at all, so the client's own request timeout fires.
  | 'silent';

const ROW = { entityId: 7, metricType: 'Like', value: 13 };
const REQUEST_TIMEOUT_MS = 300;

const server = {
  queue: [] as Behaviour[],
  requests: [] as { sql: string; connection: number | undefined }[],
};

// A port can be reused once a reset socket is gone, so connections are told apart by the id the
// server assigns as each one is accepted.
const connectionIds = new WeakMap<object, number>();
let nextConnectionId = 0;

const httpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    server.requests.push({
      sql: url.searchParams.get('query') ?? body,
      connection: connectionIds.get(req.socket),
    });
    const behaviour = server.queue.shift() ?? 'ok';
    switch (behaviour) {
      case 'reset':
        return req.socket.resetAndDestroy();
      case 'hangup':
        return req.socket.destroy();
      case 'reset-mid-body':
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify(ROW) + '\n');
        return setTimeout(() => req.socket.resetAndDestroy(), 20);
      case 'server-timeout':
        res.writeHead(500, { 'X-ClickHouse-Exception-Code': '159' });
        return res.end(
          'Code: 159. DB::Exception: Timeout exceeded: elapsed 6.001 seconds, maximum: 6. (TIMEOUT_EXCEEDED) (version 25.8.1.1)'
        );
      case 'unknown-table':
        res.writeHead(404, { 'X-ClickHouse-Exception-Code': '60' });
        return res.end(
          'Code: 60. DB::Exception: Unknown table expression identifier. (UNKNOWN_TABLE) (version 25.8.1.1)'
        );
      case 'silent':
        return;
      default:
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        return res.end(JSON.stringify(ROW) + '\n');
    }
  });
});

httpServer.on('connection', (socket) => connectionIds.set(socket, ++nextConnectionId));

let ch: ReturnType<typeof createClickhouseMetricsClient>;

// The read MetricService issues through event-engine-common's SimpleClickhouse.
const POINT_LOOKUP_SQL = `
          SELECT
            entityId,
            metricType,
            sum(total) AS value
          FROM entityMetricDailyAgg_v2
          WHERE entityId IN (7)
          GROUP BY entityId, metricType
          HAVING value > 0;
        `;
const pointLookup = async () => {
  const rs = await ch.query({
    query: POINT_LOOKUP_SQL,
    format: 'JSONEachRow',
    clickhouse_settings: { max_threads: 1, max_execution_time: 6 },
  });
  return rs.json();
};

const retryCount = async (outcome: 'ok' | 'failed') => {
  const metric = client.register.getSingleMetric(
    'civitai_app_image_metrics_clickhouse_retry_total'
  );
  if (!metric) throw new Error('retry counter is not registered');
  const { values } = await metric.get();
  return values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
};

const counted = async () => ({ ok: await retryCount('ok'), failed: await retryCount('failed') });

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: unknown; type?: unknown };
  }
  throw new Error(
    `expected the read to reject, but it resolved after ${server.requests.length} request(s)`
  );
};

describe('dedicated metrics ClickHouse client: one retry on a connection-level error', () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;
    ch = createClickhouseMetricsClient({
      host: `http://127.0.0.1:${port}`,
      username: 'metrics-user',
      password: 'metrics-pass',
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
  });

  afterAll(async () => {
    await ch.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  beforeEach(() => {
    server.queue = [];
    server.requests = [];
  });

  it.each(['reset', 'hangup', 'reset-mid-body'] as const)(
    '%s, then a good response: the read returns the data and counts one ok retry',
    async (first) => {
      const before = await counted();
      server.queue = [first, 'ok'];

      expect(await pointLookup()).toEqual([ROW]);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[1].sql).toBe(server.requests[0].sql);
      // The retry went out on a different socket than the one that failed.
      expect(server.requests[1].connection).toBeDefined();
      expect(server.requests[1].connection).not.toBe(server.requests[0].connection);
      expect(await counted()).toEqual({ ok: before.ok + 1, failed: before.failed });
    }
  );

  it('a reset twice rethrows the FIRST error and counts one failed retry', async () => {
    const before = await counted();
    // Two different failures, so the error says which attempt it came from.
    server.queue = ['reset', 'hangup'];

    const error = await rejection(pointLookup());
    expect(error.message).toBe('read ECONNRESET');
    expect(error.code).toBe('ECONNRESET');
    expect(server.requests).toHaveLength(2);
    expect(await counted()).toEqual({ ok: before.ok, failed: before.failed + 1 });
  });

  it('a refused connection is retried once, then rethrown as ECONNREFUSED', async () => {
    const { port } = httpServer.address() as AddressInfo;
    // Bound and released, so nothing listens on it.
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    expect(deadPort).not.toBe(port);
    const refused = createClickhouseMetricsClient({
      host: `http://127.0.0.1:${deadPort}`,
      username: 'metrics-user',
      password: 'metrics-pass',
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    const before = await counted();

    try {
      const error = await rejection(refused.query({ query: 'SELECT 1', format: 'JSONEachRow' }));
      expect(error.code).toBe('ECONNREFUSED');
    } finally {
      await refused.close();
    }
    expect(await counted()).toEqual({ ok: before.ok, failed: before.failed + 1 });
  });

  // MetricService marks the batch with `markLookupTimedOut` on exactly this error
  // (String(code) === '159'), so it must arrive once, unchanged, and not be re-run.
  it('a server timeout (TIMEOUT_EXCEEDED) is not retried and reaches the caller unchanged', async () => {
    const before = await counted();
    server.queue = ['server-timeout', 'ok'];

    const error = await rejection(pointLookup());
    expect(String(error.code)).toBe('159');
    expect(error.type).toBe('TIMEOUT_EXCEEDED');
    expect(server.requests).toHaveLength(1);
    expect(await counted()).toEqual(before);
  });

  it('another server error is not retried', async () => {
    const before = await counted();
    server.queue = ['unknown-table', 'ok'];

    const error = await rejection(pointLookup());
    expect(error.type).toBe('UNKNOWN_TABLE');
    expect(server.requests).toHaveLength(1);
    expect(await counted()).toEqual(before);
  });

  it("the client's own request timeout is not retried", async () => {
    const before = await counted();
    server.queue = ['silent', 'ok'];

    const error = await rejection(pointLookup());
    expect(error.message).toBe('Timeout error.');
    expect(server.requests).toHaveLength(1);
    expect(await counted()).toEqual(before);
  });

  it('a statement that is not a read is not retried, through query or any other method', async () => {
    const before = await counted();

    server.queue = ['reset', 'ok'];
    expect((await rejection(ch.query({ query: 'INSERT INTO t SELECT 1' }))).code).toBe(
      'ECONNRESET'
    );
    expect(server.requests).toHaveLength(1);

    server.queue = ['reset', 'ok'];
    expect((await rejection(ch.command({ query: 'SELECT 1' }))).code).toBe('ECONNRESET');
    expect(server.requests).toHaveLength(2);

    server.queue = ['reset', 'ok'];
    expect((await rejection(ch.exec({ query: 'SELECT 1' }))).code).toBe('ECONNRESET');
    expect(server.requests).toHaveLength(3);

    server.queue = ['reset', 'ok'];
    expect(
      (await rejection(ch.insert({ table: 't', values: [{ a: 1 }], format: 'JSONEachRow' }))).code
    ).toBe('ECONNRESET');
    expect(server.requests).toHaveLength(4);

    expect(await counted()).toEqual(before);
  });
});

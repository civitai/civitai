import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClickhouseClient } from '@civitai/clickhouse/client';

// The real driver against a stand-in server that goes quiet before answering, as ClickHouse does
// while a spilled GROUP BY merges: no progress headers, no bytes. request_timeout is an idle timer,
// so a client whose timeout is shorter than the silence drops a query the server would have answered.
describe('request_timeout against a silent server', () => {
  const SILENCE_MS = 600;
  let server: Server;
  let host: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end('{"n":1}\n');
      }, SILENCE_MS);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const read = async (requestTimeoutMs: number) => {
    const client = createClickhouseClient({ host, username: 'u', password: 'p', requestTimeoutMs });
    try {
      const result = await client.query({ query: 'SELECT 1 AS n', format: 'JSONEachRow' });
      return await result.json<{ n: number }>();
    } finally {
      await client.close();
    }
  };

  it('drops the query when the silence outlasts the timeout', async () => {
    await expect(read(SILENCE_MS / 3)).rejects.toThrow('Timeout error');
  });

  it('waits the silence out when the timeout is longer', async () => {
    expect(await read(SILENCE_MS * 5)).toEqual([{ n: 1 }]);
  });
});

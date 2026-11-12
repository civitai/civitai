import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
// vitest is the workspace root's dev dependency; package test files run from the root suite.
// eslint-disable-next-line import/no-extraneous-dependencies
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuzzClient } from './client';

// Fault injection against a REAL local HTTP server, not a fetch mock: the failures that matter here
// (a write that commits and then answers 503, an endpoint that accepts the connection and never
// answers) only exist on a socket, and a mocked fetch cannot show whether the client's own retry or
// timeout ever fired.

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

async function stub(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => handler(req, res, body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};

/** A ledger that COMMITS every write it receives, then answers 503 to the first one. */
async function commitThen503Once(path: string) {
  const ledger: string[] = [];
  const endpoint = await stub((req, res, body) => {
    if (req.method !== 'POST' || req.url !== path) return json(res, 404, {});
    ledger.push(body);
    if (ledger.length === 1) return json(res, 503, {});
    return json(res, 200, { transactionId: `tx-${ledger.length}`, remainingBalance: 0 });
  });
  return { ledger, endpoint };
}

const transaction = {
  fromAccountId: 0,
  toAccountId: 42,
  amount: 100,
  type: 5,
  externalTransactionId: 'test:commit-then-503',
};

describe('writes are never re-sent after the server may have run them', () => {
  it('createTransaction: a write that committed and then answered 503 lands exactly once', async () => {
    const { ledger, endpoint } = await commitThen503Once('/transaction');
    const client = createBuzzClient({ endpoint });

    await expect(client.createTransaction(transaction)).rejects.toMatchObject({ status: 503 });
    expect(ledger).toHaveLength(1);
  });

  it('createTransactions (batch): same, one ledger write for one call', async () => {
    const { ledger, endpoint } = await commitThen503Once('/transactions');
    const client = createBuzzClient({ endpoint });

    await expect(client.createTransactions([transaction])).rejects.toMatchObject({ status: 503 });
    expect(ledger).toHaveLength(1);
  });

  it('still retries a write that provably never reached the server (connection refused)', async () => {
    // Positive control for the predicate: a closed port refuses, and refusing is the one failure
    // where "nothing happened" is knowable. The write must be retried there, or a rolling restart
    // turns every grant into a user-visible failure.
    const endpoint = await stub(() => undefined);
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const client = createBuzzClient({ endpoint });
      await expect(client.createTransaction(transaction)).rejects.toBeInstanceOf(TypeError);
      // 1 attempt + the client's default 3 retries: refused connections are absorbed here.
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('refuses to send a transaction with a blank externalTransactionId', async () => {
    const ledger: string[] = [];
    const endpoint = await stub((_req, res, body) => {
      ledger.push(body);
      json(res, 200, { transactionId: 'tx', remainingBalance: 0 });
    });
    const client = createBuzzClient({ endpoint });

    await expect(
      client.createTransaction({ ...transaction, externalTransactionId: '  ' })
    ).rejects.toThrow(/externalTransactionId/);
    await expect(
      client.createTransactions([{ ...transaction, externalTransactionId: '' }])
    ).rejects.toThrow(/externalTransactionId/);
    expect(ledger).toHaveLength(0);
  });
});

describe('reads are bounded by default', () => {
  it('a balance endpoint that never answers rejects in under 4s, with no options passed', async () => {
    let hits = 0;
    const endpoint = await stub(() => {
      hits++; // accept, never respond
    });
    const client = createBuzzClient({ endpoint });

    const started = Date.now();
    await expect(client.getUserAccounts(42, ['yellow'])).rejects.toThrow();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(4_000);
    // A timeout is not retried: against a hung service a retry only doubles the wait.
    expect(hits).toBe(1);
  }, 15_000);

  it('a per-call budget shorter than the default wins', async () => {
    const endpoint = await stub(() => undefined);
    const client = createBuzzClient({ endpoint });

    const started = Date.now();
    await expect(
      client.getUserAccounts(42, ['yellow'], { timeoutMs: 500, retries: 0 })
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_500);
  }, 15_000);

  it('a read that fails fast with a 503 is retried once, and only once', async () => {
    let hits = 0;
    const endpoint = await stub((_req, res) => {
      hits++;
      json(res, 503, {});
    });
    const client = createBuzzClient({ endpoint });

    await expect(client.getAccount(42)).rejects.toMatchObject({ status: 503 });
    expect(hits).toBe(2);
  });
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuzzClient } from '@civitai/buzz';

// A moderator grant/deduct against a REAL local ledger stub and the real `@civitai/buzz` client.
// The ledger records every write it receives and does NOT dedupe on externalTransactionId, because
// whether the real service does is not established; the guarantee has to hold without it.

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
const { recordModActivity } = vi.hoisted(() => ({ recordModActivity: vi.fn(async () => {}) }));
vi.mock('$lib/server/mod-activity', () => ({ recordModActivity }));

let endpoint = '';
vi.mock('$lib/server/buzz', () => ({
  // A short write bound so the timeout case runs in well under a second.
  getBuzz: () => createBuzzClient({ endpoint, transactionTimeoutMs: 300 }),
}));

const { sendBuzz } = await import('$lib/server/user-actions.service');

type Behaviour = {
  /** Answer the Nth write (1-based) with this status AFTER committing it. */
  commitThenStatus?: Record<number, number>;
  /** Answer the Nth write with this status WITHOUT committing it. */
  rejectWithout?: Record<number, number>;
  /** Every lookup answers 503. */
  lookupDown?: boolean;
  /** Writes are accepted and never answered (nothing committed yet). */
  hangWrites?: boolean;
};

let server: Server | undefined;
let writes: { externalTransactionId: string; amount: number }[] = [];
let attempts = 0;

async function ledger(behaviour: Behaviour = {}) {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'GET' && req.url?.startsWith('/transactions/')) {
        if (behaviour.lookupDown) return send(503, {});
        const id = decodeURIComponent(req.url.slice('/transactions/'.length));
        const found = writes.find((w) => w.externalTransactionId === id);
        return found ? send(200, { ...found, date: '2026-11-12T00:00:00Z' }) : send(404, {});
      }
      if (req.method === 'POST' && req.url === '/transaction') {
        attempts++;
        if (behaviour.hangWrites) return; // never answer
        const rejected = behaviour.rejectWithout?.[attempts];
        if (rejected) return send(rejected, {});
        writes.push(JSON.parse(body));
        const status = behaviour.commitThenStatus?.[attempts];
        if (status) return send(status, {});
        return send(200, { transactionId: `tx-${writes.length}`, remainingBalance: null });
      }
      send(404, {});
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

beforeEach(() => {
  writes = [];
  attempts = 0;
  vi.clearAllMocks();
});
afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) await new Promise<void>((resolve) => (s.closeAllConnections(), s.close(() => resolve())));
});

const grant = {
  userId: 42,
  amount: 500,
  buzzType: 'yellow' as const,
  action: 'send' as const,
  transactionType: 'Compensation' as const,
  description: 'test grant',
  moderatorId: 7,
  submissionId: '0123456789abcdef0123456789abcdef',
};

describe('moderator sendBuzz', () => {
  it('a write that committed and then answered 503 is filed once and reported as filed', async () => {
    await ledger({ commitThenStatus: { 1: 503 } });

    await expect(sendBuzz(grant)).resolves.toEqual({ ok: true });
    expect(writes).toHaveLength(1);
    expect(writes[0].externalTransactionId).toBe(`moderator-buzz-${grant.submissionId}`);
  });

  it('a resubmit of the same form after a lost response files nothing more', async () => {
    await ledger({ commitThenStatus: { 1: 504 } });

    await sendBuzz(grant);
    const second = await sendBuzz(grant);
    expect(second).toMatchObject({ ok: false, error: expect.stringMatching(/already filed/) });
    expect(writes).toHaveLength(1);
  });

  it('a write the ledger refused without committing is reported as not filed', async () => {
    await ledger({ rejectWithout: { 1: 503 } });

    const result = await sendBuzz(grant);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Nothing was filed/) });
    expect(writes).toHaveLength(0);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('a write that TIMED OUT is not reported as "nothing filed", even when the lookup finds nothing yet', async () => {
    await ledger({ hangWrites: true });

    const result = await sendBuzz(grant);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/may still have gone through/),
    });
    expect(result).not.toMatchObject({ error: expect.stringMatching(/Nothing was filed/) });
  });

  it('files nothing when the ledger cannot be asked whether this form was already filed', async () => {
    await ledger({ lookupDown: true });

    const result = await sendBuzz(grant);
    expect(result).toMatchObject({ ok: false });
    expect(attempts).toBe(0);
  });

  it('refuses a malformed submission id before touching the ledger', async () => {
    await ledger();
    const result = await sendBuzz({ ...grant, submissionId: '../x' });
    expect(result).toMatchObject({ ok: false });
    expect(attempts).toBe(0);
  });

  it('files a fresh grant once, and audits it', async () => {
    await ledger();
    await expect(sendBuzz(grant)).resolves.toEqual({ ok: true });
    expect(writes).toHaveLength(1);
    expect(recordModActivity).toHaveBeenCalledTimes(1);
  });
});

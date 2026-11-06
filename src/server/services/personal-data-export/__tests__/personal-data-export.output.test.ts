import { describe, expect, it } from 'vitest';
import { csvCell, type ExportWriter } from '../output';
import {
  CH_TABLES,
  USER_BUZZ_ACCOUNT_TYPES,
  exportClickhouse,
  reduceChRow,
  type ClickhouseReader,
} from '../sources/clickhouse';
import { exportWorkflows, reduceWorkflow, type WorkflowCollection } from '../sources/mongo';
import { exportStripe, reduceStripe, type StripeReader } from '../sources/stripe';

const writer = () => {
  const files = new Map<string, string>();
  const w: ExportWriter = {
    async addFile(name, content) {
      let text = '';
      if (typeof content === 'string') text = content;
      else for await (const c of content) text += c;
      files.set(name, text);
    },
  };
  return { files, w };
};

describe('csvCell', () => {
  it('quotes, serialises and defuses spreadsheet formulas in text', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(new Date('2026-11-06T00:00:00Z'))).toBe('2026-11-06T00:00:00.000Z');
    expect(csvCell(BigInt(10))).toBe('10');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(null)).toBe('');
    // Control: a number is data, not a formula, and stays as written.
    expect(csvCell(-5)).toBe('-5');
  });
});

describe('reduceWorkflow', () => {
  it('keeps dates as ISO text, and drops blocked outputs and detection keys in any shape', () => {
    const out = reduceWorkflow({
      createdAt: new Date('2026-11-06T00:00:00Z'),
      output: { url: 'https://blob/bad', blockedReason: 'x' },
      ok: { url: 'https://blob/ok', blocked: false },
      xguardResult: { s: 1 },
      scores: [0.1],
    }) as Record<string, unknown>;
    expect(out.createdAt).toBe('2026-11-06T00:00:00.000Z');
    expect(out).not.toHaveProperty('output');
    expect(out.ok).toEqual({ url: 'https://blob/ok', blocked: false });
    expect(out).not.toHaveProperty('xguardResult');
    expect(out).not.toHaveProperty('scores');
  });

  it('marks the file partial when the server time limit ends the read, and closes the cursor', async () => {
    let closed = 0;
    const collection: WorkflowCollection = {
      find() {
        return Object.assign(
          (async function* () {
            yield { _id: '1-a' };
            throw Object.assign(new Error('time'), { codeName: 'MaxTimeMSExpired' });
          })(),
          { close: async () => void closed++ }
        );
      },
    };
    const { files, w } = writer();
    const entry = await exportWorkflows({ userId: 1, writer: w, collection });
    expect(entry).toMatchObject({ status: 'partial', rows: 1 });
    expect(files.get(entry.file)).toBe('{"_id":"1-a"}\n');
    expect(closed).toBe(1);
  });
});

describe('Stripe', () => {
  it('drops card fingerprints and secrets at any depth', () => {
    const out = JSON.stringify(
      reduceStripe({
        id: 'ch_1',
        payment_method_details: { card: { last4: '4242', fingerprint: 'f' } },
        client_secret: 's',
      })
    );
    expect(out).toContain('4242');
    expect(out).not.toContain('fingerprint');
    expect(out).not.toContain('client_secret');
  });

  it("keeps a charge's plain outcome and drops the risk verdict", () => {
    const out = reduceStripe({
      outcome: {
        network_status: 'approved_by_network',
        seller_message: 'Payment complete.',
        risk_level: 'normal',
        risk_score: 12,
        rule: 'r',
        type: 'authorized',
      },
      fraud_details: { stripe_report: 'x' },
    });
    expect(out).toEqual({
      outcome: { network_status: 'approved_by_network', seller_message: 'Payment complete.' },
    });
  });

  it('marks a failing list unavailable and still writes the others', async () => {
    const list = (items: unknown[]) =>
      (async function* () {
        yield* items;
      })();
    const stripe: StripeReader = {
      customers: { retrieve: async () => ({ id: 'cus_1' }) },
      charges: { list: () => list([{ id: 'ch_1' }]) },
      invoices: {
        list: () =>
          (async function* () {
            throw new Error('stripe down');
          })(),
      },
      subscriptions: { list: () => list([]) },
    };
    const { files, w } = writer();
    const errors: string[] = [];
    const result = await exportStripe({
      customerId: 'cus_1',
      writer: w,
      stripe,
      onError: (x) => errors.push(x),
    });
    expect(result.map((f) => [f.file, f.status, f.rows])).toEqual([
      ['data/stripe/customer.jsonl', 'complete', 1],
      ['data/stripe/charges.jsonl', 'complete', 1],
      ['data/stripe/invoices.jsonl', 'unavailable', 0],
      ['data/stripe/subscriptions.jsonl', 'complete', 0],
    ]);
    expect(errors).toEqual(['stripe:invoices']);
    expect(files.has('data/stripe/subscriptions.jsonl')).toBe(false);
  });
});

describe('ClickHouse', () => {
  it('keeps only the prompt and time of a blocked request, and drops moderation fields elsewhere', () => {
    const blocked = CH_TABLES.find((t) => t.table === 'default.prohibitedRequests')!;
    expect(reduceChRow(blocked, { time: 't', prompt: 'p', source: 'detector', score: 1 })).toEqual({
      time: 't',
      prompt: 'p',
      blocked: true,
    });
    const jobs = CH_TABLES.find((t) => t.table === 'orchestration.jobs')!;
    expect(
      reduceChRow(jobs, { id: 'j', cost: 3, nsfwLevel: 2, blockedReason: 'x', reviewedBy: 9 })
    ).toEqual({
      id: 'j',
      cost: 3,
    });
  });

  it('picks the user-id type per table, marks a failing table unavailable and goes on', async () => {
    const queries: { query: string; params?: Record<string, unknown> }[] = [];
    const ch: ClickhouseReader = {
      async query({ query, query_params }) {
        queries.push({ query, params: query_params });
        if (query.includes('system.columns'))
          return {
            json: async <T>() => [{ t: 'orchestration.jobs', type: 'String' }] as T,
            stream: async function* () {
              yield* [];
            },
          };
        if (query.includes('system.tables'))
          return {
            json: async <T>() =>
              [
                { t: 'default.buzzTransactions', sortingKey: 'date, fromAccountId', rows: 2e9 },
                { t: 'default.userActivities', sortingKey: 'time, type, userId', rows: 5e7 },
                { t: 'orchestration.jobs', sortingKey: 'createdAt', rows: 1000 },
                { t: 'default.views', sortingKey: 'time, entityType, entityId, userId', rows: 8e9 },
                {
                  t: 'default.userModelDownloads',
                  sortingKey: 'userId, modelVersionId',
                  rows: 2e8,
                },
              ] as T,
            stream: async function* () {
              yield* [];
            },
          };
        if (query.includes('default.userActivities')) throw new Error('ch down');
        return {
          json: async <T>() => [] as T,
          stream: async function* () {
            yield [{ json: <T>() => ({ id: 'r' } as T) }];
          },
        };
      },
    };
    const { w } = writer();
    const errors: string[] = [];
    const result = await exportClickhouse({
      userId: 7,
      writer: w,
      ch,
      onError: (t) => errors.push(t),
    });
    const jobsQuery = queries.find((q) => q.query.includes('FROM orchestration.jobs'))!;
    expect(jobsQuery.query).toContain('userId = {uidText:String}');
    expect(jobsQuery.params).toMatchObject({ uid: 7, uidText: '7' });
    expect(result.files.find((f) => f.file.endsWith('account-activity.jsonl'))?.status).toBe(
      'unavailable'
    );
    expect(result.files.find((f) => f.file.endsWith('generation-jobs.jsonl'))).toMatchObject({
      status: 'complete',
      rows: 1,
    });
    expect(errors).toContain('default.userActivities');
  });

  it('keeps what a large read wrote before it failed, and marks that file partial', async () => {
    const ch: ClickhouseReader = {
      async query({ query }) {
        const shapes = [{ t: 'default.buzzTransactions', sortingKey: 'date', rows: 2e9 }];
        return {
          json: async <T>() => (query.includes('system.tables') ? shapes : []) as T,
          stream: async function* () {
            if (!query.includes('buzzTransactions')) return;
            yield [{ json: <T>() => ({ id: 1 } as T) }, { json: <T>() => ({ id: 2 } as T) }];
            throw new Error('Timeout exceeded: elapsed 300 seconds');
          },
        };
      },
    };
    const { files, w } = writer();
    const errors: string[] = [];
    const result = await exportClickhouse({
      userId: 7,
      writer: w,
      ch,
      onError: (t) => errors.push(t),
    });
    const buzz = result.files.find((f) => f.file.endsWith('buzz-transactions.jsonl'))!;
    expect(buzz).toMatchObject({ status: 'partial', rows: 2 });
    expect(files.get(buzz.file)).toBe('{"id":1}\n{"id":2}\n');
    expect(errors).toContain('default.buzzTransactions');
  });

  it("reads only the user's own Buzz accounts, never a club keyed by the same id", async () => {
    expect(USER_BUZZ_ACCOUNT_TYPES).toEqual(
      expect.arrayContaining(['yellow', 'blue', 'cashPending'])
    );
    expect(USER_BUZZ_ACCOUNT_TYPES).not.toContain('club');
    const buzz = CH_TABLES.find((t) => t.table === 'default.buzzTransactions')!;
    expect(buzz.where).toContain('fromAccountType IN {buzzTypes:Array(String)}');
    expect(buzz.where).toContain('toAccountType IN {buzzTypes:Array(String)}');
  });

  it('skips a full scan of a large table not keyed by user, but always reads the Buzz ledger', async () => {
    const queries: { query: string; params?: Record<string, unknown> }[] = [];
    const ch: ClickhouseReader = {
      async query({ query, query_params }) {
        queries.push({ query, params: query_params });
        const shapes = [
          { t: 'default.buzzTransactions', sortingKey: 'date, fromAccountId', rows: 2e9 },
          { t: 'orchestration.jobs', sortingKey: 'createdAt', rows: 3e9 },
          { t: 'default.views', sortingKey: 'time, entityType, entityId, userId', rows: 8e9 },
          { t: 'default.userModelDownloads', sortingKey: 'userId, modelVersionId', rows: 2e8 },
        ];
        const rows = query.includes('system.tables')
          ? shapes
          : query.includes('count()')
          ? [{ n: 3 }]
          : [];
        return {
          json: async <T>() => rows as T,
          stream: async function* () {
            yield* [];
          },
        };
      },
    };
    const result = await exportClickhouse({
      userId: 7,
      writer: writer().w,
      ch,
      onError: () => undefined,
    });
    expect(result.files.find((f) => f.file.endsWith('generation-jobs.jsonl'))?.status).toBe(
      'unavailable'
    );
    expect(queries.some((q) => q.query.includes('FROM orchestration.jobs'))).toBe(false);
    expect(queries.some((q) => q.query.includes('FROM default.views'))).toBe(false);
    expect(result.counts.find((c) => c.name === 'views')?.count).toBeNull();
    expect(result.counts.find((c) => c.name === 'userModelDownloads')?.count).toBe(3);
    const buzzQuery = queries.find((q) => q.query.includes('FROM default.buzzTransactions'))!;
    expect(buzzQuery.params?.buzzTypes).toEqual(USER_BUZZ_ACCOUNT_TYPES);
  });
});

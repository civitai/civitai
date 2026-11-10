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
      reduceChRow(jobs, {
        jobId: 'j',
        cost: 3,
        provider: 'p',
        nsfwLevel: 2,
        blockedReason: 'x',
        reviewedBy: 9,
      })
    ).toEqual({ jobId: 'j', cost: 3, provider: 'p' });
  });

  it('drops `source` from an account-activity row and keeps the rest of it', () => {
    const activity = CH_TABLES.find((t) => t.table === 'default.userActivities')!;
    expect(
      reduceChRow(activity, {
        type: 'Muted',
        time: '2026-11-08 12:00:00',
        userId: 42,
        targetUserId: 77,
        landingPage: '/models/1',
        source: 'mute-pending-review (queue: spam)',
      })
    ).toEqual({
      type: 'Muted',
      time: '2026-11-08 12:00:00',
      userId: 42,
      targetUserId: 77,
      landingPage: '/models/1',
    });
    // Scoped to that table: a `source` column elsewhere goes by that table's own policy.
    const buzz = CH_TABLES.find((t) => t.table === 'default.buzzTransactions')!;
    expect(reduceChRow(buzz, { type: 'tip', source: 's' })).toMatchObject({ source: 's' });
  });

  it("leaves another user's id out of a Buzz row, as the app's own Buzz export does", () => {
    const buzz = CH_TABLES.find((t) => t.table === 'default.buzzTransactions')!;
    const reward = reduceChRow(buzz, {
      date: '2026-11-01 00:00:00',
      type: 'reward',
      amount: 10,
      details: JSON.stringify({ byUserId: 555, entityId: 3 }),
      externalTransactionId: 'goodContent:3-7-555',
    });
    expect(reward).toMatchObject({ amount: 10, details: { entityId: 3 } });
    expect(reward.externalTransactionId).toBeNull();
    expect(JSON.stringify(reward)).not.toContain('555');
    // Another type keeps its ledger id; only the other user's id goes from its details.
    const tip = reduceChRow(buzz, {
      type: 'tip',
      details: JSON.stringify({ byUserId: 555, note: 'hi' }),
      externalTransactionId: 'tip-123',
    });
    expect(tip).toEqual({ type: 'tip', details: { note: 'hi' }, externalTransactionId: 'tip-123' });
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
            yield [{ json: <T>() => ({ id: 'r', createdAt: '2024-01-01 00:00:00' } as T) }];
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

  /**
   * Ruled by Legal and the Moderation Lead: generation jobs go in every archive, read by an approved
   * column list (no worker, issuer or remix ids), so a column added to the table later does not
   * flow through; and a row corrupted in storage is left out and counted, never sent.
   */
  it('reads generation jobs by their approved columns only, and leaves corrupted rows out', async () => {
    const garbage = `ab${String.fromCharCode(1)}cd`;
    const base = {
      jobId: 'j1',
      userId: '7',
      createdAt: '2023-04-05 10:00:00',
      provider: '',
      cost: 4,
      workerId: 'w-9',
      issuedBy: 'svc',
      remixOfId: 'r-1',
      someNewColumn: 'should not appear',
    };
    const stored = [
      base,
      { ...base, jobId: 'j2', createdAt: '2299-01-01 00:00:00' },
      { ...base, jobId: 'j3', createdAt: '1900-01-01 00:00:00' },
      { ...base, jobId: 'j4', provider: garbage },
    ];
    const queries: string[] = [];
    const ch: ClickhouseReader = {
      async query({ query }) {
        queries.push(query);
        const shapes = [{ t: 'orchestration.jobs', sortingKey: 'createdAt', rows: 3e9 }];
        return {
          json: async <T>() => (query.includes('system.tables') ? shapes : []) as T,
          stream: async function* () {
            if (query.includes('FROM orchestration.jobs'))
              yield stored.map((r) => ({ json: <T>() => r as T }));
          },
        };
      },
    };
    const { files, w } = writer();
    const result = await exportClickhouse({ userId: 7, writer: w, ch, onError: () => undefined });

    const jobsQuery = queries.find((q) => q.includes('FROM orchestration.jobs'))!;
    expect(jobsQuery).not.toContain('SELECT *');
    for (const omitted of ['workerId', 'issuedBy', 'remixOfId'])
      expect(jobsQuery).not.toContain(omitted);
    expect(jobsQuery).toContain('`provider`');

    const jobs = result.files.find((f) => f.file.endsWith('generation-jobs.jsonl'))!;
    expect(jobs).toMatchObject({ status: 'complete', rows: 1, leftOut: 3 });
    const written = files
      .get(jobs.file)!
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // Only the valid 2023 row, with only approved columns; an empty provider reads as unknown.
    expect(written).toEqual([
      { jobId: 'j1', userId: '7', createdAt: '2023-04-05 10:00:00', provider: 'unknown', cost: 4 },
    ]);
  });

  it("reads only the user's own Buzz accounts, never a club keyed by the same id", async () => {
    expect(USER_BUZZ_ACCOUNT_TYPES).toEqual(
      expect.arrayContaining(['yellow', 'blue', 'cashPending'])
    );
    expect(USER_BUZZ_ACCOUNT_TYPES).not.toContain('club');
  });

  it('skips a full scan of a large table not keyed by user, but always reads the Buzz ledger', async () => {
    const queries: { query: string; params?: Record<string, unknown> }[] = [];
    const ch: ClickhouseReader = {
      async query({ query, query_params }) {
        queries.push({ query, params: query_params });
        const shapes = [
          { t: 'default.buzzTransactions', sortingKey: 'date, fromAccountId', rows: 2e9 },
          { t: 'orchestration.jobs', sortingKey: 'createdAt', rows: 3e9 },
          { t: 'default.prohibitedRequests', sortingKey: 'time', rows: 3e9 },
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
    expect(result.files.find((f) => f.file.endsWith('blocked-prompts.jsonl'))?.status).toBe(
      'not-included'
    );
    expect(queries.some((q) => q.query.includes('FROM default.prohibitedRequests'))).toBe(false);
    // Required: read whatever its size.
    expect(result.files.find((f) => f.file.endsWith('generation-jobs.jsonl'))?.status).toBe(
      'complete'
    );
    expect(queries.some((q) => q.query.includes('FROM orchestration.jobs'))).toBe(true);
    expect(queries.some((q) => q.query.includes('FROM default.views'))).toBe(false);
    expect(result.counts.find((c) => c.name === 'views')?.count).toBeNull();
    expect(result.counts.find((c) => c.name === 'userModelDownloads')?.count).toBe(3);
    const buzzQueries = queries.filter((q) => q.query.includes('FROM default.buzzTransactions'));
    expect(buzzQueries[0].params?.buzzTypes).toEqual(USER_BUZZ_ACCOUNT_TYPES);
    // One query per side, so each reads its own projection: an OR of the two scans the ledger.
    expect(buzzQueries.length).toBe(2);
    expect(buzzQueries.filter((q) => / OR /i.test(q.query))).toEqual([]);
  });
});

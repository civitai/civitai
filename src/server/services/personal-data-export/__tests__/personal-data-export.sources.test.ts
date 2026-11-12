import { describe, expect, it } from 'vitest';
import type { ExportWriter } from '../output';
import { PG_FETCH_SIZE, exportPostgres, planPostgresExport } from '../sources/postgres';
import {
  MONGO_BATCH_SIZE,
  MONGO_DOC_CAP,
  MONGO_MAX_TIME_MS,
  exportWorkflows,
  reduceWorkflow,
  workflowRange,
  type WorkflowCollection,
} from '../sources/mongo';

const SUBJECT = 777;

/** Collects every file in memory, the way the zip would receive them. */
function memoryWriter() {
  const files = new Map<string, string>();
  const writer: ExportWriter = {
    async addFile(name, content) {
      let text = '';
      if (typeof content === 'string') text = content;
      else for await (const chunk of content) text += chunk;
      files.set(name, text);
    },
  };
  return { files, writer };
}

/**
 * A pg client whose cursor serves `rowsFor(table)` in FETCH-sized pages. Tables named in `failOn`
 * fail at DECLARE. Bounded: a FETCH past the data returns an empty page, and the number of FETCHes is
 * capped so a paging bug reads as a count, not a hang.
 */
function fakeClient(opts: {
  rowsFor: (table: string) => Record<string, unknown>[];
  failOn?: Set<string>;
  failMidStream?: string;
  /** Catalog rows for the index check: (table, leading column | null, estimated rows). */
  catalog?: { table: string; column: string | null; est: string }[];
}) {
  let current: { rows: Record<string, unknown>[]; offset: number; table: string } | null = null;
  let fetches = 0;
  let released = 0;
  // Like Postgres: after an error, everything but ROLLBACK fails until the transaction ends.
  let aborted = false;
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql === 'ROLLBACK' || sql === 'COMMIT') {
        aborted = false;
        current = null;
        return { rows: [] };
      }
      if (aborted) throw new Error('current transaction is aborted');
      if (sql.startsWith('SELECT cl.relname')) return { rows: opts.catalog ?? [] };
      const declare =
        /^DECLARE export_cursor NO SCROLL CURSOR FOR SELECT .*? FROM "([^"]+)" WHERE/s.exec(sql);
      if (declare) {
        if (opts.failOn?.has(declare[1])) {
          aborted = true;
          throw new Error(`boom ${declare[1]}`);
        }
        current = { rows: opts.rowsFor(declare[1]), offset: 0, table: declare[1] };
        return { rows: [] };
      }
      if (sql.startsWith('FETCH')) {
        if (++fetches > 10_000) throw new Error('too many FETCHes');
        if (!current) throw new Error('FETCH with no cursor');
        if (current.table === opts.failMidStream && current.offset > 0)
          throw new Error('mid-stream');
        const page = current.rows.slice(current.offset, current.offset + PG_FETCH_SIZE);
        current.offset += page.length;
        return { rows: page };
      }
      return { rows: [] };
    },
    release: () => {
      released++;
    },
  };
  return { client, statements, fetches: () => fetches, released: () => released };
}

describe('exportPostgres', () => {
  const comments = Array.from({ length: PG_FETCH_SIZE * 2 + 3 }, (_, i) => ({
    id: i + 1,
    userId: SUBJECT,
    content: `c${i}`,
  }));

  it('writes every row across pages, and the manifest counts what was written', async () => {
    const { files, writer } = memoryWriter();
    const { client, statements, released } = fakeClient({
      rowsFor: (t) => (t === 'CommentV3' ? comments : []),
    });
    const result = await exportPostgres({
      userId: SUBJECT,
      writer,
      connect: async () => client as never,
      onNote: () => undefined,
      onError: () => undefined,
    });
    const entry = result.files.find((f) => f.file === 'data/postgres/CommentV3.csv');
    const csv = files.get('data/postgres/CommentV3.csv') ?? '';
    const dataLines = csv.split('\r\n').filter(Boolean).length - 1;
    expect(dataLines).toBe(comments.length);
    expect(entry?.rows).toBe(comments.length);
    expect(entry?.status).toBe('complete');
    // Each table is read in its own read-only transaction with a statement limit scoped to it, and
    // the pooled connection goes back.
    const begins = statements.filter((q) => q === 'BEGIN READ ONLY').length;
    expect(begins).toBe(result.files.length);
    expect(statements.filter((q) => q.startsWith('SET LOCAL statement_timeout')).length).toBe(
      begins
    );
    expect(statements.some((q) => /^SET statement_timeout/.test(q))).toBe(false);
    expect(released()).toBe(1);
  });

  it('skips, as unavailable, a large table whose subject column leads no index', async () => {
    const { writer } = memoryWriter();
    const { client, statements } = fakeClient({
      rowsFor: () => [],
      catalog: [
        { table: 'CommentV3', column: null, est: '90000000' },
        { table: 'CommentV3', column: 'id', est: '90000000' },
        { table: 'Article', column: null, est: '90000000' },
        { table: 'Article', column: 'userId', est: '90000000' },
      ],
    });
    const result = await exportPostgres({
      userId: SUBJECT,
      writer,
      connect: async () => client as never,
      onNote: () => undefined,
      onError: () => undefined,
    });
    const status = (t: string) =>
      result.files.find((f) => f.file === `data/postgres/${t}.csv`)?.status;
    expect(status('CommentV3')).toBe('not-included');
    expect(status('Article')).toBe('complete');
    expect(statements.some((q) => /CURSOR FOR SELECT .*? FROM "CommentV3" WHERE/s.test(q))).toBe(
      false
    );
  });

  it('writes no file for an empty table but still lists it with zero rows', async () => {
    const { files, writer } = memoryWriter();
    const { client } = fakeClient({ rowsFor: () => [] });
    const result = await exportPostgres({
      userId: SUBJECT,
      writer,
      connect: async () => client as never,
      onNote: () => undefined,
      onError: () => undefined,
    });
    expect(files.size).toBe(0);
    expect(result.files.length).toBe(planPostgresExport(SUBJECT).length);
    expect(result.files.every((f) => f.rows === 0)).toBe(true);
  });

  it('marks a table that fails before its file starts unavailable, and goes on', async () => {
    const { files, writer } = memoryWriter();
    const errors: string[] = [];
    const { client } = fakeClient({
      rowsFor: (t) => (t === 'CommentV3' ? comments.slice(0, 2) : []),
      failOn: new Set(['Article']),
    });
    const result = await exportPostgres({
      userId: SUBJECT,
      writer,
      connect: async () => client as never,
      onNote: () => undefined,
      onError: (t) => errors.push(t),
    });
    expect(result.files.find((f) => f.file === 'data/postgres/Article.csv')?.status).toBe(
      'unavailable'
    );
    expect(errors).toEqual(['Article']);
    expect(files.has('data/postgres/CommentV3.csv')).toBe(true);
  });

  it('fails the whole attempt when a table fails after its file started', async () => {
    const { writer } = memoryWriter();
    const { client } = fakeClient({
      rowsFor: (t) => (t === 'CommentV3' ? comments : []),
      failMidStream: 'CommentV3',
    });
    await expect(
      exportPostgres({
        userId: SUBJECT,
        writer,
        connect: async () => client as never,
        onNote: () => undefined,
        onError: () => undefined,
      })
    ).rejects.toThrow('mid-stream');
  });

  it('counts internal notes and hands them over without writing them into the data file', async () => {
    const { files, writer } = memoryWriter();
    const notes: string[] = [];
    const { client } = fakeClient({
      rowsFor: (t) =>
        t === 'Appeal'
          ? [
              { id: 1, userId: SUBJECT, internalNotes: 'secret note', resolvedReason: 'mod text' },
              { id: 2, userId: SUBJECT, internalNotes: null },
            ]
          : [],
    });
    const result = await exportPostgres({
      userId: SUBJECT,
      writer,
      connect: async () => client as never,
      onNote: (n) => notes.push(n.text),
      onError: () => undefined,
    });
    expect(result.noteCount).toBe(2);
    expect(notes.sort()).toEqual(['mod text', 'secret note']);
    expect(files.get('data/postgres/Appeal.csv')).not.toContain('secret note');
    expect(files.get('data/postgres/Appeal.csv')).not.toContain('mod text');
  });
});

describe('exportWorkflows', () => {
  it('reads the id range for the user, by _id, with the batch, time and cap limits', async () => {
    let seen: unknown[] = [];
    const collection: WorkflowCollection = {
      find(filter, options) {
        seen = [filter, options];
        return Object.assign(
          (async function* () {
            yield* [];
          })(),
          { close: async () => undefined }
        );
      },
    };
    await exportWorkflows({ userId: SUBJECT, writer: memoryWriter().writer, collection });
    expect(seen).toEqual([
      { _id: { $gte: '777-', $lt: '777.' } },
      {
        sort: { _id: 1 },
        hint: '_id_',
        batchSize: MONGO_BATCH_SIZE,
        maxTimeMS: MONGO_MAX_TIME_MS,
        limit: MONGO_DOC_CAP + 1,
      },
    ]);
  });

  it('marks the file partial past the cap, and stops reading', async () => {
    let yielded = 0;
    const collection: WorkflowCollection = {
      find() {
        return Object.assign(
          (async function* () {
            for (let i = 0; i < MONGO_DOC_CAP + 50; i++) {
              yielded++;
              yield { _id: `777-${i}` };
            }
          })(),
          { close: async () => undefined }
        );
      },
    };
    const entry = await exportWorkflows({
      userId: SUBJECT,
      writer: memoryWriter().writer,
      collection,
    });
    expect(entry.status).toBe('partial');
    expect(entry.rows).toBe(MONGO_DOC_CAP);
    expect(yielded).toBeLessThan(MONGO_DOC_CAP + 2);
  });

  it('drops tokens and blocked outputs from a document', () => {
    const doc = {
      _id: '777-1',
      callbackUrl: 'https://x/cb?token=1',
      accessToken: 'abc',
      steps: [
        {
          prompt: 'a cat',
          output: {
            images: [
              { id: 'ok', url: 'https://blob/ok' },
              { id: 'bad', url: 'https://blob/bad', blockedReason: 'policy' },
            ],
          },
        },
      ],
    };
    const out = JSON.stringify(reduceWorkflow(doc));
    expect(out).toContain('a cat');
    expect(out).toContain('https://blob/ok');
    expect(out).not.toContain('https://blob/bad');
    expect(out).not.toContain('accessToken');
    expect(out).not.toContain('callbackUrl');
  });

  it('refuses a user id that is not a positive integer', () => {
    expect(() => workflowRange(0)).toThrow();
    expect(() => workflowRange(-1)).toThrow();
  });
});

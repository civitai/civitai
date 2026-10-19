import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootLabelStore } from '~/server/services/__tests__/label-store.fixture';
import type { TextScanModelLabelInput } from '~/server/services/text-scan/label-capture';

// Runs the committed label-store migration on real Postgres: a mocked statement can't show that a label lands, a retry records nothing, or a store failure leaves the decision standing.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const db = { pg: null as unknown as PGlite };
const refused = new Set<string>();
const storeCallTimeouts: string[] = [];
const tx = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { text, values: params } = Prisma.sql(strings, ...(values as never[]));
    if (text.includes('label_store.record_label('))
      storeCallTimeouts.push(
        (await db.pg.query<{ statement_timeout: string }>('SHOW statement_timeout')).rows[0]
          .statement_timeout
      );
    return (await db.pg.query(text, params as unknown[])).rows;
  },
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { text, values: params } = Prisma.sql(strings, ...(values as never[]));
    if ([...refused].some((prefix) => text.startsWith(prefix)))
      throw new Error(`connection refused ${text}`);
    return (await db.pg.query(text, params as unknown[])).affectedRows ?? 0;
  },
};

const { recordTextScanModelLabel } = await import('~/server/services/text-scan/label-capture');
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');
const { composeUserText } = await import('~/server/services/text-scan/segment');

const MODEL = 7;
const OWNER = 42;
const MOD = 21;
const OTHER_MOD = 22;
const TEXT = '## Name\nA model\n\n## Description\nsome scanned text';
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const HASH = sha256(TEXT);

const ruling = (over: Partial<TextScanModelLabelInput> = {}): TextScanModelLabelInput => ({
  modelId: MODEL,
  label: 'minor',
  value: 'flag',
  labellerKind: 'moderator',
  moderatorId: MOD,
  textHash: HASH,
  text: TEXT,
  verdict: { workflowId: 'wf-1', promptIds: { base: 1, minor: 2 }, reason: 'verdict reason' },
  reason: 'reason-slug',
  note: 'a note',
  ...over,
});

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.pg.query<T>(sql, params)).rows;

type LabelRow = {
  family: string;
  question: string;
  value: string;
  labellerKind: string;
  labellerRef: string;
  reason: string | null;
  reasonNote: string | null;
  sourceRef: string;
  subjectType: string;
  subjectId: string;
  contentHash: string;
  snapshot: Record<string, unknown> | null;
  ownerHash: string | null;
};
const labels = () =>
  rows<LabelRow>(
    `SELECT l.*, s."subjectType", s."subjectId" AS "subjectId", s."contentHash", s."snapshot", s."ownerHash"
     FROM label_store.label l JOIN label_store.subject s ON s.id = l."subjectId" ORDER BY l.id`
  );
const failures = () => rows<{ sourceRef: string }>(`SELECT * FROM label_store.record_failure`);
const personHash = async (kind: 'owner' | 'labeller', id: number) =>
  (await rows<{ h: string }>(`SELECT label_store.person_hash($1, $2) AS h`, [kind, id]))[0].h;

async function decide(input: TextScanModelLabelInput, end: 'COMMIT' | 'ROLLBACK' = 'COMMIT') {
  await db.pg.exec('BEGIN');
  await db.pg.query(`UPDATE "Model" SET minor = $1 WHERE id = $2`, [input.value === 'flag', MODEL]);
  const recorded = await recordTextScanModelLabel(tx, input);
  await db.pg.exec(end);
  return recorded;
}
const minorFlag = async () =>
  (await rows<{ minor: boolean }>(`SELECT minor FROM "Model" WHERE id = $1`, [MODEL]))[0].minor;

beforeAll(async () => {
  db.pg = await PGlite.create();
  await bootLabelStore(db.pg);
  await db.pg.exec(
    `CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL, minor boolean NOT NULL DEFAULT false)`
  );
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`
    TRUNCATE label_store.subject, label_store.change, label_store.record_failure,
      label_store.erased_subject, label_store.erased_owner RESTART IDENTITY CASCADE;
    TRUNCATE "Model";
  `);
  await db.pg.query(`INSERT INTO "Model" (id, "userId") VALUES ($1, $2)`, [MODEL, OWNER]);
});

// The flag carries the scan's hash, computed in TS; the store keys and checks the snapshot by its own
// SQL hash. A ruling's text is kept only while the two agree.
describe('the scan and the store hash text alike', () => {
  it('for multi-byte text across fields', async () => {
    const subject = {
      fields: [
        { heading: 'Name', text: '  Ñandú 😀 model  ' },
        { heading: 'Description', text: 'naïve café — 日本語\nline two' },
      ],
      declared: {},
    };
    const [{ h }] = await rows<{ h: string }>(`SELECT label_store.text_hash($1) AS h`, [
      composeUserText(subject as never),
    ]);

    expect(h).toBe(textScanTextHash(subject as never));
  });
});

describe('recordTextScanModelLabel', () => {
  it('records the ruling with the scanned text, its hash and the model owner', async () => {
    expect(await decide(ruling())).toBe(true);

    const [label] = await labels();
    expect(label).toMatchObject({
      subjectType: 'model_text',
      subjectId: String(MODEL),
      contentHash: HASH,
      family: 'text_scan',
      question: 'text_scan.model.minor',
      value: 'flag',
      labellerKind: 'moderator',
      labellerRef: await personHash('labeller', MOD),
      ownerHash: await personHash('owner', OWNER),
      reason: 'reason-slug',
      reasonNote: 'a note',
      snapshot: {
        text: TEXT,
        textHash: HASH,
        workflowId: 'wf-1',
        promptIds: { base: 1, minor: 2 },
        verdictReason: 'verdict reason',
      },
    });
    expect(
      (
        await rows<{ h: string }>(`SELECT label_store.text_hash($1) AS h`, [label.snapshot?.text])
      )[0].h
    ).toBe(label.contentHash);
    expect(label.sourceRef.split(':')).not.toContain(String(MOD));
  });

  it('asks the question of the ruled label and answers clear for a lift', async () => {
    await decide(ruling({ label: 'poi', value: 'clear' }));

    const [label] = await labels();
    expect(label).toMatchObject({ question: 'text_scan.model.poi', value: 'clear' });
  });

  it('records nothing for a retry of the same ruling, and a second moderator separately', async () => {
    expect(await decide(ruling())).toBe(true);
    expect(await decide(ruling())).toBe(false);
    expect(await decide(ruling({ moderatorId: OTHER_MOD }))).toBe(true);

    expect((await labels()).map((l) => l.labellerRef)).toEqual([
      await personHash('labeller', MOD),
      await personHash('labeller', OTHER_MOD),
    ]);
    expect(await failures()).toEqual([]);
  });

  it('keeps an appeal outcome apart from the moderator ruling and out of consensus', async () => {
    await decide(ruling({ labellerKind: 'appeal' }));

    const [label] = await labels();
    expect(label.labellerKind).toBe('appeal');
    expect(await rows(`SELECT * FROM label_store.consensus WHERE "humanLabels" > 0`)).toEqual([]);

    expect(await decide(ruling())).toBe(true);
    expect(await labels()).toHaveLength(2);
  });

  it('keeps the ruled hash but drops text that was edited since the scan', async () => {
    await decide(ruling({ text: `${TEXT} edited` }));

    const [label] = await labels();
    expect(label.contentHash).toBe(HASH);
    expect(label.snapshot).toEqual({
      textHash: HASH,
      workflowId: 'wf-1',
      promptIds: { base: 1, minor: 2 },
      verdictReason: 'verdict reason',
    });
  });

  it('records with no text when it could not be composed', async () => {
    expect(await decide(ruling({ text: null }))).toBe(true);
    expect((await labels())[0].snapshot).not.toHaveProperty('text');
  });

  it('rolls back with the decision it belongs to', async () => {
    await decide(ruling(), 'ROLLBACK');

    expect(await labels()).toEqual([]);
    expect(await minorFlag()).toBe(false);
  });

  it('leaves the decision standing when the store refuses the label', async () => {
    await db.pg.query(`SELECT label_store.erase_owner($1)`, [OWNER]);

    expect(await decide(ruling())).toBe(false);
    expect(await minorFlag()).toBe(true);
    expect(await labels()).toEqual([]);
    expect(await failures()).toHaveLength(1);
  });

  // A slow store is cut off and rolled back to the savepoint instead of running the ruling's
  // transaction out of time; the cap ends with that transaction.
  it('caps each store call with a statement timeout for the rest of the decision only', async () => {
    storeCallTimeouts.length = 0;

    expect(await decide(ruling())).toBe(true);

    expect(storeCallTimeouts).toEqual(['3s']);
    expect((await rows<{ statement_timeout: string }>('SHOW statement_timeout'))[0]).toEqual({
      statement_timeout: '0',
    });
  });

  // A failed rollback leaves the transaction aborted, and its COMMIT would silently roll the
  // decision back: the caller must see the failure instead of a success.
  it('fails the decision loudly when the savepoint cannot be rolled back', async () => {
    await db.pg.exec(`ALTER SCHEMA label_store RENAME TO label_store_absent`);
    refused.add('ROLLBACK TO SAVEPOINT');
    await db.pg.exec('BEGIN');
    try {
      await expect(recordTextScanModelLabel(tx, ruling())).rejects.toThrow('connection refused');
    } finally {
      refused.clear();
      await db.pg.exec('ROLLBACK');
      await db.pg.exec(`ALTER SCHEMA label_store_absent RENAME TO label_store`);
    }
  });

  it('fails the decision loudly when the savepoint cannot be taken', async () => {
    refused.add('SAVEPOINT');
    await db.pg.exec('BEGIN');
    try {
      await expect(recordTextScanModelLabel(tx, ruling())).rejects.toThrow('connection refused');
    } finally {
      refused.clear();
      await db.pg.exec('ROLLBACK');
    }
  });

  it('leaves the decision standing when the store is missing', async () => {
    await db.pg.exec(`ALTER SCHEMA label_store RENAME TO label_store_absent`);
    try {
      expect(await decide(ruling())).toBe(false);
      expect(await minorFlag()).toBe(true);
    } finally {
      await db.pg.exec(`ALTER SCHEMA label_store_absent RENAME TO label_store`);
    }
  });
});

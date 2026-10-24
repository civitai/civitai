import { sql, type Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB as ModeratorDB } from '../moderator-db/types';
import type { Workspace } from '$lib/text-scan-tests/types';
import { importSeed, parseBench, parseLabSeed, parseTruthMap } from '../text-scan-tests/seed';
import { listCases, listSets } from '../text-scan-tests/store';
import { useTestSetsDb } from './text-scan-tests-pglite.harness';

let db: Kysely<ModeratorDB>;
const sets = useTestSetsDb();

beforeEach(async () => {
  ({ db } = sets);
});

const SECRET = 'synthetic fixture sentence';
const LAB_SEED = {
  cases: [
    {
      entityType: 'Model',
      entityId: 4321,
      authorId: 8765,
      fields: [{ heading: 'Name', text: `${SECRET} a` }],
      expected: { nsfw: { min: 'pg13', max: 'r' } },
    },
    {
      entityType: 'Model',
      fields: [{ heading: 'Name', text: `${SECRET} b` }],
      expected: { poi: true },
    },
    { entityType: 'Nope', fields: [{ heading: 'Name', text: `${SECRET} c` }], expected: {} },
    {
      entityType: 'Model',
      entityId: 4321,
      fields: [{ heading: 'Name', text: `${SECRET} d` }],
      expected: {},
    },
  ],
};
const BENCH = [
  {
    key: 'k-1',
    entityType: 'CommentV2',
    fields: [{ heading: 'Comment', text: `${SECRET} e` }],
    truth: 'bad',
  },
  {
    key: 'k-2',
    entityType: 'CommentV2',
    fields: [{ heading: 'Comment', text: `${SECRET} f` }],
    truth: 'fine',
  },
  {
    key: 'k-3',
    entityType: 'CommentV2',
    fields: [{ heading: 'Comment', text: `${SECRET} g` }],
    truth: 'unsure',
  },
  {
    key: 'k-4',
    entityType: 'CommentV2',
    fields: [{ heading: 'Comment', text: `${SECRET} h` }],
    truth: 'other',
  },
];

describe('parsing', () => {
  it('reads a truth map and refuses an unknown outcome', () => {
    expect(parseTruthMap('bad=yes,fine=no,unsure=skip')).toEqual({
      bad: 'yes',
      fine: 'no',
      unsure: 'skip',
    });
    expect(parseTruthMap('bad=maybe')).toBe('--truth-map values are yes, no or skip.');
  });

  it('keeps nsfw ranges from a lab seed and counts refusals by reason', () => {
    const parsed = parseLabSeed(LAB_SEED);
    if (typeof parsed === 'string') throw new Error(parsed);
    expect(parsed.rows.map((r) => r.expected)).toEqual([
      { nsfw: { min: 'pg13', max: 'r' } },
      { poi: true },
    ]);
    expect(parsed.refused).toEqual({ 'unknown entity type': 1, 'duplicate entity': 1 });
  });

  it('accepts an explicit null entity id, as for the author', () => {
    const parsed = parseLabSeed({
      cases: [{ ...LAB_SEED.cases[1], entityId: null, authorId: null }],
    });
    if (typeof parsed === 'string') throw new Error(parsed);
    expect(parsed.refused).toEqual({});
    expect(parsed.rows).toEqual([expect.objectContaining({ entityId: null, authorId: null })]);
  });

  it('trims the keys and values of a truth map', () => {
    expect(parseTruthMap(' bad = yes , fine=no ')).toEqual({ bad: 'yes', fine: 'no' });
  });

  it('counts an inherited property name as an unmapped truth value', () => {
    const rows = ['constructor', 'toString', '__proto__'].map((truth) => ({
      ...BENCH[0],
      key: truth,
      truth,
    }));
    const parsed = parseBench(rows, 'scam', parseTruthMap('bad=yes') as never);
    expect(typeof parsed !== 'string' && parsed.refused).toEqual({ 'unmapped truth value': 3 });
    expect(parseTruthMap('__proto__=yes')).toEqual(JSON.parse('{"__proto__":"yes"}'));
  });

  it('maps bench truth through the map, skipping and refusing as told', () => {
    const parsed = parseBench(BENCH, 'scam', parseTruthMap('bad=yes,fine=no,unsure=skip') as never);
    if (typeof parsed === 'string') throw new Error(parsed);
    expect(parsed.rows.map((r) => [r.sourceRef, r.expected])).toEqual([
      ['k-1', { scam: true }],
      ['k-2', { scam: false }],
      ['k-3', {}],
    ]);
    expect(parsed.refused).toEqual({ 'unmapped truth value': 1 });
  });

  it('refuses a bench label the entity type does not score', () => {
    const parsed = parseBench(BENCH.slice(0, 1), 'poi', { bad: 'yes' });
    expect(typeof parsed !== 'string' && parsed.refused).toEqual({
      'label not scored for entity type': 1,
    });
  });
});

describe('importSeed', () => {
  const opts = {
    set: 'synthetic seed set',
    workspace: 'prompts' as const,
    format: 'bench' as const,
    label: 'scam' as const,
    truthMap: { bad: 'yes', fine: 'no', unsure: 'skip' } as const,
    by: 990001,
  };

  it('dry run writes nothing and reports counts only', async () => {
    const summary = await importSeed(db, BENCH, { ...opts, write: false });
    expect(summary).toMatchObject({
      rows: 3,
      byEntityType: { CommentV2: 3 },
      byLabel: { scam: 2 },
      written: null,
    });
    expect(await listSets(db, 'prompts')).toEqual([]);
    const printed = JSON.stringify(summary);
    for (const leak of [SECRET, 'k-1', '4321', 'bad', 'fine']) expect(printed).not.toContain(leak);
  });

  it('writes idempotently on the source ref', async () => {
    await importSeed(db, BENCH, { ...opts, write: true });
    const again = await importSeed(db, BENCH, { ...opts, write: true });
    expect(again.written).toEqual({ created: 0, updated: 3 });
    const [set] = await listSets(db, 'prompts');
    expect(await listCases(db, set.id)).toHaveLength(3);
  });

  it('rescores the set once when a re-import changes a case', async () => {
    await importSeed(db, BENCH, { ...opts, write: true });
    const [set] = await listSets(db, 'prompts');
    const [first] = await listCases(db, set.id);
    const run = await db
      .insertInto('text_scan_test_run')
      .values({
        set_id: String(set.id),
        kind: 'baseline',
        start_id: '00000000-0000-4000-8000-000000000009',
        max_case_id: String(first.id + 10),
        prompt_ids: '{}',
        model: 'model-a',
        thinking: false,
        status: 'done',
        run_by: 990001,
        totals: '[]',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('text_scan_test_result')
      .values({
        run_id: run.id,
        case_id: String(first.id),
        status: 'ok',
        output: JSON.stringify({ scam: { detected: true } }),
      })
      .execute();
    await importSeed(db, BENCH, {
      ...opts,
      truthMap: { bad: 'no', fine: 'no', unsure: 'skip' },
      write: true,
    });
    const { totals } = await db
      .selectFrom('text_scan_test_run')
      .select('totals')
      .executeTakeFirstOrThrow();
    expect(totals).toEqual([expect.objectContaining({ label: 'scam', scored: 1, passed: 0 })]);
  });

  it('refuses a set that belongs to the other workspace', async () => {
    await importSeed(db, BENCH, { ...opts, write: true });
    await expect(
      importSeed(db, BENCH, { ...opts, workspace: 'modelRules' as Workspace, write: true })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('counts a row the store refuses under a fixed reason and still lands the rest', async () => {
    const mixed = {
      cases: [
        { entityType: 'Model', fields: [{ heading: 'Name', text: `${SECRET} m` }], expected: {} },
        {
          entityType: 'Model',
          fields: [{ heading: 'Name', text: `${SECRET} r` }],
          expected: { scam: true },
        },
      ],
    };
    const summary = await importSeed(db, mixed, { ...opts, format: 'lab-seed', write: true });
    expect(summary.written).toEqual({ created: 1, updated: 0 });
    expect(summary.refused).toEqual({ 'bad expectation': 1 });
    const [set] = await listSets(db, 'prompts');
    expect(await listCases(db, set.id)).toHaveLength(1);
    const printed = JSON.stringify(summary);
    for (const leak of [SECRET, opts.set]) expect(printed).not.toContain(leak);
  });

  it('refuses an archived set without naming it', async () => {
    await importSeed(db, BENCH, { ...opts, write: true });
    await db.updateTable('text_scan_test_set').set({ archived_at: new Date() }).execute();
    await expect(importSeed(db, BENCH, { ...opts, write: true })).rejects.toMatchObject({
      status: 409,
      message: 'That set is archived.',
    });
  });

  it('counts a row that collides on another unique key as conflicting and lands the rest', async () => {
    await importSeed(db, [BENCH[0]], { ...opts, write: true });
    // Same source ref as the stored case but a new entity id: the entity upsert finds no conflict, the source_ref key does.
    const rows = [
      { ...BENCH[0], entityId: 777 },
      { ...BENCH[1], entityId: 778 },
    ];
    const summary = await importSeed(db, rows, { ...opts, write: true });
    expect(summary.refused).toEqual({ 'conflicting case': 1 });
    expect(summary.written).toEqual({ created: 1, updated: 0 });
    const [set] = await listSets(db, 'prompts');
    expect(await listCases(db, set.id)).toHaveLength(2);
    const printed = JSON.stringify(summary);
    for (const leak of [SECRET, 'k-1', '777', '778', opts.set]) expect(printed).not.toContain(leak);
  });

  it('rolls the whole import back on an error that is not a refusal', async () => {
    await sql`
      CREATE FUNCTION fail_on_entity() RETURNS trigger AS $$
      BEGIN IF NEW.entity_id = 99 THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`.execute(
      db
    );
    await sql`
      CREATE TRIGGER fail_on_entity BEFORE INSERT ON text_scan_test_case
        FOR EACH ROW EXECUTE FUNCTION fail_on_entity()`.execute(db);
    const rows = [BENCH[0], { ...BENCH[1], entityId: 99 }];
    await expect(importSeed(db, rows, { ...opts, write: true })).rejects.toBeDefined();
    expect(await listSets(db, 'prompts')).toEqual([]);
    expect(await db.selectFrom('text_scan_test_case').selectAll().execute()).toEqual([]);
  });
});

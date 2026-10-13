import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB as ModeratorDB } from '../moderator-db/types';
import { importSeed, parseBench, parseLabSeed, parseTruthMap } from '../text-scan-tests/seed';
import { listCases, listSets } from '../text-scan-tests/store';
import { freshTestSetsDb } from './text-scan-tests-pglite.harness';

let db: Kysely<ModeratorDB>;
beforeEach(async () => {
  ({ db } = await freshTestSetsDb());
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

  it('refuses a set that belongs to the other workspace', async () => {
    await importSeed(db, BENCH, { ...opts, write: true });
    await expect(
      importSeed(db, BENCH, { ...opts, workspace: 'modelRules', write: true })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('counts a row the store refuses under a fixed reason and still lands the rest', async () => {
    const mixed = {
      cases: [
        { entityType: 'Model', fields: [{ heading: 'Name', text: `${SECRET} m` }], expected: {} },
        {
          entityType: 'ModelRules',
          fields: [{ heading: 'Name', text: `${SECRET} r` }],
          expected: {},
        },
      ],
    };
    const summary = await importSeed(db, mixed, { ...opts, format: 'lab-seed', write: true });
    expect(summary.written).toEqual({ created: 1, updated: 0 });
    expect(summary.refused).toEqual({ 'rejected by validation': 1 });
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
});

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import {
  applyTagIndexRetention,
  selectTagIndexSnapshotsToRetire,
  TAG_INDEX_KEEP_READY,
  TAG_INDEX_OBJECT_GRACE_MS,
  TAG_INDEX_OTHER_SPEC_KEEP_DAYS,
  type TagIndexRetentionRow,
} from '~/server/services/resource-intent-tags/retention';
import {
  isTagIndexObjectKey,
  type TagIndexObjectInfo,
  type TagIndexObjectSweeper,
} from '~/server/services/resource-intent-tags/store';
import { asFixtureWriter, pgliteSql, utcPglite } from './resource-intent-cooc.harness';

/**
 * Tag-index retention against both real migrations in PGlite (so retiring goes through the table's
 * one-way trigger) and an in-memory object store with modification times.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const DAY = 86_400_000;
const NOW = new Date('2026-11-10T07:00:00Z');
const SPEC = 'd'.repeat(64);
const OLD_SPEC = 'e'.repeat(64);
const OTHER_SPEC = 'f'.repeat(64);
const PREFIX = 'resource-intent/tag-index';
const hex = (label: string) => createHash('sha256').update(label).digest('hex');
const keyOf = (label: string) => `${PREFIX}/${hex(label)}`;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const migration = (name: string) =>
  readFileSync(
    join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations', name, 'migration.sql'),
    'utf8'
  );

describe('selectTagIndexSnapshotsToRetire', () => {
  const row = (
    id: string,
    specHash: string,
    ageDays: number,
    status = 'ready'
  ): TagIndexRetentionRow => ({
    id,
    status,
    specHash,
    objectKey: keyOf(id),
    createdAt: ago(ageDays * DAY),
  });

  it(`keeps the newest ${TAG_INDEX_KEEP_READY} ready rows of the running spec, however old`, () => {
    const rows = [0, 7, 14, 21, 28, 400].map((d) => row(`c${d}`, SPEC, d));
    expect(selectTagIndexSnapshotsToRetire(rows, SPEC, NOW).sort()).toEqual(['c21', 'c28', 'c400']);
    expect(selectTagIndexSnapshotsToRetire(rows.slice(3), SPEC, NOW)).toEqual([]);
  });

  it('orders by createdAt, then id (as the holder picks), not by input order', () => {
    const rows = [row('b', SPEC, 1), row('a', SPEC, 1), row('z', SPEC, 0), row('y', SPEC, 2)];
    // newest: z, then the tie b > a by id descending, then y.
    expect(selectTagIndexSnapshotsToRetire(rows, SPEC, NOW)).toEqual(['y']);
  });

  it(`keeps another spec's newest ready row for ${TAG_INDEX_OTHER_SPEC_KEEP_DAYS} days, and no other`, () => {
    const rows = [
      row('o1', OLD_SPEC, 10),
      row('o2', OLD_SPEC, 17),
      row('x1', OTHER_SPEC, TAG_INDEX_OTHER_SPEC_KEEP_DAYS + 1),
      row('x-edge', OTHER_SPEC, TAG_INDEX_OTHER_SPEC_KEEP_DAYS + 3),
    ];
    expect(selectTagIndexSnapshotsToRetire(rows, SPEC, NOW).sort()).toEqual(['o2', 'x-edge', 'x1']);
    const atLimit = [row('o', OLD_SPEC, TAG_INDEX_OTHER_SPEC_KEEP_DAYS)];
    expect(selectTagIndexSnapshotsToRetire(atLimit, SPEC, NOW)).toEqual([]);
  });

  it('ignores retired rows, both as candidates and when counting what is kept', () => {
    const rows = [
      row('r0', SPEC, 0, 'retired'),
      row('a', SPEC, 1),
      row('b', SPEC, 2),
      row('c', SPEC, 3),
      row('d', SPEC, 4),
    ];
    expect(selectTagIndexSnapshotsToRetire(rows, SPEC, NOW)).toEqual(['d']);
  });
});

describe('isTagIndexObjectKey', () => {
  it('accepts exactly <prefix>/<64 lowercase hex>', () => {
    expect(isTagIndexObjectKey(PREFIX, keyOf('a'))).toBe(true);
    expect(isTagIndexObjectKey(PREFIX, `${PREFIX}/${hex('a').toUpperCase()}`)).toBe(false);
    expect(isTagIndexObjectKey(PREFIX, `${PREFIX}/${hex('a')}x`)).toBe(false);
    expect(isTagIndexObjectKey(PREFIX, `${PREFIX}/sub/${hex('a').slice(4)}`)).toBe(false);
    expect(isTagIndexObjectKey(PREFIX, `other/${hex('a')}`)).toBe(false);
    expect(isTagIndexObjectKey(PREFIX, `${PREFIX}x/${hex('a').slice(1)}`)).toBe(false);
  });
});

type Seed = { label: string; specHash?: string; status?: 'ready' | 'retired'; ageDays: number };

async function freshStore(seeds: Seed[], objects: { label: string; ageMs: number }[]) {
  const db = await utcPglite(
    migration('20261029120000_resource_intent_tags'),
    migration('20261103120000_resource_intent_tag_index_snapshot')
  );
  const vocab = Buffer.from('{"v":1}');
  const vocabVersion = hex('{"v":1}');
  await db.query(
    `INSERT INTO "ResourceIntentVocabulary" ("vocabVersion", "payload", "rulesSummary", "status", "frozenAt", "frozenBy")
     VALUES ($1, $2, '{}', 'frozen', '2026-10-01T00:00:00Z', 'operator')`,
    [vocabVersion, vocab]
  );
  // The guard trigger stamps createdAt with now() on insert; a fixture writer sets it explicitly.
  await asFixtureWriter(db, async () => {
    for (const s of seeds)
      await db.query(
        `INSERT INTO "ResourceIntentTagIndexSnapshot"
           ("id", "status", "retiredAt", "vocabVersion", "specHash", "payloadSha256", "payloadBytes",
            "objectKey", "buildStats", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, 10, $7, '{}', $8)`,
        [
          s.label + (s.status === 'retired' ? '-r' : ''),
          s.status ?? 'ready',
          s.status === 'retired' ? ago(DAY) : null,
          vocabVersion,
          s.specHash ?? SPEC,
          hex(s.label),
          keyOf(s.label),
          ago(s.ageDays * DAY),
        ]
      );
  });
  const store = new Map<string, TagIndexObjectInfo>();
  for (const o of objects) {
    const key = o.label.includes('/') ? o.label : keyOf(o.label);
    store.set(key, { key, lastModified: ago(o.ageMs), bytes: 10 });
  }
  const deleted: string[] = [];
  const sweeper: TagIndexObjectSweeper = {
    prefix: PREFIX,
    put: async () => undefined,
    get: async () => {
      throw new Error('not used');
    },
    list: async function* () {
      for (const o of store.values()) yield o;
    },
    // Records every call, refusing nothing, so retention's own key check is what the tests see.
    delete: async (key) => {
      deleted.push(key);
      store.delete(key);
    },
  };
  const statuses = async () =>
    Object.fromEntries(
      (
        await db.query<{ id: string; status: string; retiredAt: Date | null }>(
          `SELECT "id", "status", "retiredAt" FROM "ResourceIntentTagIndexSnapshot" ORDER BY "id"`
        )
      ).rows.map((r) => [r.id, `${r.status}${r.retiredAt ? '+at' : ''}`])
    );
  return { db, sql: pgliteSql(db), sweeper, store, deleted, statuses };
}

const OLD = TAG_INDEX_OBJECT_GRACE_MS + 60_000;

describe('applyTagIndexRetention', () => {
  it('retires beyond the keep window through the trigger, then deletes only unnamed, old, snapshot-shaped objects', async () => {
    const s = await freshStore(
      [
        { label: 'w0', ageDays: 0 },
        { label: 'w1', ageDays: 7 },
        { label: 'w2', ageDays: 14 },
        { label: 'w3', ageDays: 21 },
        { label: 'w4', ageDays: 28 },
        { label: 'gone', ageDays: 60, status: 'retired' },
        { label: 'old-spec', specHash: OLD_SPEC, ageDays: 5 },
      ],
      [
        ...['w0', 'w1', 'w2', 'w3', 'w4', 'gone', 'old-spec'].map((label) => ({
          label,
          ageMs: OLD,
        })),
        { label: 'orphan-old', ageMs: OLD },
        { label: 'orphan-new', ageMs: TAG_INDEX_OBJECT_GRACE_MS - 60_000 },
        // An upload two hours old, past the build job's 90-minute lock: still inside the grace.
        { label: 'orphan-2h', ageMs: 2 * 3_600_000 },
        { label: `${PREFIX}/README`, ageMs: OLD },
      ]
    );
    const result = await applyTagIndexRetention(
      { sql: s.sql, objects: s.sweeper },
      { now: NOW, specHash: SPEC }
    );
    expect(result.retired.sort()).toEqual(['w3', 'w4']);
    expect(await s.statuses()).toEqual({
      'gone-r': 'retired+at',
      'old-spec': 'ready',
      w0: 'ready',
      w1: 'ready',
      w2: 'ready',
      w3: 'retired+at',
      w4: 'retired+at',
    });
    expect(s.deleted.sort()).toEqual(
      [keyOf('gone'), keyOf('orphan-old'), keyOf('w3'), keyOf('w4')].sort()
    );
    expect(result.deleted).toEqual({ retired: 3, orphaned: 1, bytes: 40 });
    expect(result.keptRecent).toBe(2);
    expect(result.foreign).toBe(1);
    expect([...s.store.keys()].sort()).toEqual(
      [
        keyOf('w0'),
        keyOf('w1'),
        keyOf('w2'),
        keyOf('old-spec'),
        keyOf('orphan-new'),
        keyOf('orphan-2h'),
        `${PREFIX}/README`,
      ].sort()
    );
  });

  it('keeps an object a ready row names even when a retired row names it too (a re-put)', async () => {
    const s = await freshStore(
      [
        { label: 'same', ageDays: 30, status: 'retired' },
        { label: 'same', ageDays: 1 },
      ],
      [{ label: 'same', ageMs: OLD }]
    );
    const result = await applyTagIndexRetention(
      { sql: s.sql, objects: s.sweeper },
      { now: NOW, specHash: SPEC }
    );
    expect(result.retired).toEqual([]);
    expect(s.deleted).toEqual([]);
  });

  it('a run with nothing to do changes nothing', async () => {
    const s = await freshStore([{ label: 'only', ageDays: 3 }], [{ label: 'only', ageMs: OLD }]);
    const before = await s.statuses();
    expect(
      await applyTagIndexRetention({ sql: s.sql, objects: s.sweeper }, { now: NOW, specHash: SPEC })
    ).toEqual({
      retired: [],
      deleted: { retired: 0, orphaned: 0, bytes: 0 },
      keptRecent: 0,
      foreign: 0,
    });
    expect(await s.statuses()).toEqual(before);
    expect(s.deleted).toEqual([]);
  });

  it('a row inserted while the listing runs protects its object', async () => {
    const s = await freshStore([], [{ label: 'late', ageMs: OLD }]);
    const list = s.sweeper.list;
    s.sweeper.list = async function* () {
      for await (const o of list()) yield o;
      await insertLateRow(s.db);
    };
    await applyTagIndexRetention({ sql: s.sql, objects: s.sweeper }, { now: NOW, specHash: SPEC });
    expect(s.deleted).toEqual([]);
  });
});

async function insertLateRow(db: PGlite) {
  const { rows } = await db.query<{ vocabVersion: string }>(
    `SELECT "vocabVersion" FROM "ResourceIntentVocabulary" LIMIT 1`
  );
  await db.query(
    `INSERT INTO "ResourceIntentTagIndexSnapshot"
       ("vocabVersion", "specHash", "payloadSha256", "payloadBytes", "objectKey", "buildStats")
     VALUES ($1, $2, $3, 10, $4, '{}')`,
    [rows[0].vocabVersion, SPEC, hex('late'), keyOf('late')]
  );
}

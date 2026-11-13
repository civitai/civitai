import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  applyTagIndexRetention,
  selectTagIndexSnapshotsToRetire,
  TAG_INDEX_KEEP_READY,
  TAG_INDEX_OTHER_SPEC_KEEP_DAYS,
  type TagIndexRetentionRow,
} from '~/server/services/resource-intent-tags/retention';
import {
  isTagIndexObjectKey,
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

type Seed = {
  label: string;
  specHash?: string;
  status?: 'ready' | 'retired';
  ageDays: number;
  /** The row's objectKey, when not the snapshot key of its label. */
  key?: string;
};

async function freshStore(seeds: Seed[], objectLabels: string[]) {
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
          s.key ?? keyOf(s.label),
          ago(s.ageDays * DAY),
        ]
      );
  });
  // The bucket: every object present, by key. Retention can only delete, never list.
  const store = new Set(objectLabels.map((l) => (l.includes('/') ? l : keyOf(l))));
  const deleted: string[] = [];
  let listed = 0;
  const sweeper: TagIndexObjectSweeper = Object.assign(
    <TagIndexObjectSweeper>{
      prefix: PREFIX,
      put: async () => undefined,
      get: async () => {
        throw new Error('not used');
      },
      // Records every call, refusing nothing, so retention's own key check is what the tests see.
      delete: async (key: string) => {
        deleted.push(key);
        store.delete(key);
      },
    },
    {
      // A listing, should anything ask for one (retention must not: a bucket another environment
      // shares would then expose its objects). Every object reads as old.
      list: async function* () {
        listed++;
        for (const key of store) yield { key, lastModified: new Date(0), bytes: 10 };
      },
    }
  );
  const statuses = async () =>
    Object.fromEntries(
      (
        await db.query<{ id: string; status: string; retiredAt: Date | null }>(
          `SELECT "id", "status", "retiredAt" FROM "ResourceIntentTagIndexSnapshot" ORDER BY "id"`
        )
      ).rows.map((r) => [r.id, `${r.status}${r.retiredAt ? '+at' : ''}`])
    );
  return {
    db,
    sql: pgliteSql(db),
    sweeper,
    store,
    deleted,
    statuses,
    vocabVersion,
    listed: () => listed,
  };
}

describe('applyTagIndexRetention', () => {
  it('retires beyond the keep window through the trigger, then deletes only the objects its retired rows name', async () => {
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
      ['w0', 'w1', 'w2', 'w3', 'w4', 'gone', 'old-spec', 'other-env', `${PREFIX}/README`]
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
    expect(s.deleted.sort()).toEqual([keyOf('gone'), keyOf('w3'), keyOf('w4')].sort());
    expect(result).toMatchObject({ deleted: 3, foreign: 0 });
    expect([...s.store].sort()).toEqual(
      [
        keyOf('w0'),
        keyOf('w1'),
        keyOf('w2'),
        keyOf('old-spec'),
        keyOf('other-env'),
        `${PREFIX}/README`,
      ].sort()
    );
  });

  it("an unnamed snapshot-shaped object (another environment's, in a shared bucket) survives", async () => {
    const s = await freshStore(
      [
        { label: 'mine-old', ageDays: 90, status: 'retired' },
        { label: 'mine', ageDays: 1 },
      ],
      ['mine-old', 'mine', 'theirs-1', 'theirs-2']
    );
    await applyTagIndexRetention({ sql: s.sql, objects: s.sweeper }, { now: NOW, specHash: SPEC });
    expect(s.deleted).toEqual([keyOf('mine-old')]);
    expect(s.store.has(keyOf('theirs-1'))).toBe(true);
    expect(s.store.has(keyOf('theirs-2'))).toBe(true);
    expect(s.listed()).toBe(0);
  });

  it('keeps an object a ready row names even when a retired row names it too (a re-put)', async () => {
    const s = await freshStore(
      [
        { label: 'same', ageDays: 30, status: 'retired' },
        { label: 'same', ageDays: 1 },
      ],
      ['same']
    );
    const result = await applyTagIndexRetention(
      { sql: s.sql, objects: s.sweeper },
      { now: NOW, specHash: SPEC }
    );
    expect(result.retired).toEqual([]);
    expect(s.deleted).toEqual([]);
  });

  it('a ready row inserted after the retire (a put of the same bytes) protects its object', async () => {
    const s = await freshStore(
      [0, 7, 14, 21].map((d) => ({ label: `w${d}`, ageDays: d })),
      ['w0', 'w7', 'w14', 'w21']
    );
    const execute = s.sql.execute;
    s.sql.execute = async (q) => {
      const n = await execute(q);
      // The retire just happened; the build now re-puts w21's bytes as a fresh ready row.
      await s.db.query(
        `INSERT INTO "ResourceIntentTagIndexSnapshot"
           ("vocabVersion", "specHash", "payloadSha256", "payloadBytes", "objectKey", "buildStats")
         VALUES ($1, $2, $3, 10, $4, '{}')`,
        [s.vocabVersion, SPEC, hex('w21'), keyOf('w21')]
      );
      return n;
    };
    const result = await applyTagIndexRetention(
      { sql: s.sql, objects: s.sweeper },
      { now: NOW, specHash: SPEC }
    );
    expect(result.retired).toEqual(['w21']);
    expect(s.deleted).toEqual([]);
  });

  it('a retired row naming a key that is not a snapshot key under the prefix is counted, never deleted', async () => {
    const s = await freshStore(
      [{ label: 'elsewhere', ageDays: 60, status: 'retired', key: `other/${hex('elsewhere')}` }],
      [`other/${hex('elsewhere')}`]
    );
    const result = await applyTagIndexRetention(
      { sql: s.sql, objects: s.sweeper },
      { now: NOW, specHash: SPEC }
    );
    expect(result).toEqual({ retired: [], deleted: 0, foreign: 1 });
    expect(s.deleted).toEqual([]);
  });

  it('a delete that fails does not stop the others; the sweep then fails, naming it', async () => {
    const s = await freshStore(
      [
        { label: 'r1', ageDays: 60, status: 'retired' },
        { label: 'r2', ageDays: 61, status: 'retired' },
        { label: 'r3', ageDays: 62, status: 'retired' },
      ],
      ['r1', 'r2', 'r3']
    );
    const del = s.sweeper.delete;
    let failedKey = '';
    s.sweeper.delete = async (key: string) => {
      if (!failedKey) {
        failedKey = key;
        throw new Error('AccessDenied');
      }
      return del(key);
    };
    const e = await applyTagIndexRetention(
      { sql: s.sql, objects: s.sweeper },
      { now: NOW, specHash: SPEC }
    ).catch((x: Error) => x);
    // The other two were still deleted.
    expect(s.deleted.sort()).toEqual(
      [keyOf('r1'), keyOf('r2'), keyOf('r3')].filter((k) => k !== failedKey).sort()
    );
    expect((e as Error).message).toBe(
      `tag index retention: 1 of 3 deletes failed (2 deleted, 0 retired): ${failedKey}: AccessDenied`
    );
  });

  it('a run with nothing to do changes nothing', async () => {
    const s = await freshStore([{ label: 'only', ageDays: 3 }], ['only']);
    const before = await s.statuses();
    expect(
      await applyTagIndexRetention({ sql: s.sql, objects: s.sweeper }, { now: NOW, specHash: SPEC })
    ).toEqual({ retired: [], deleted: 0, foreign: 0 });
    expect(await s.statuses()).toEqual(before);
    expect(s.deleted).toEqual([]);
  });
});

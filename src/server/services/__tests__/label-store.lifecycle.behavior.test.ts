import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootLabelStore, LABEL_STORE_MIGRATION } from './label-store.fixture';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The label store over a subject's life: hashing, consensus edge cases, exclusion and erasure, bytes,
 * the change feed, the backfills and re-applying the migration. Runs the committed migration.
 */

const db = { pg: null as unknown as PGlite };

const OWNER = 11;
const IMAGE = 501;
const ITEM = 7;
const MODS = [21, 22, 23, 24];
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const HASH = sha256('u-501');

beforeAll(async () => {
  db.pg = await PGlite.create();
  await bootLabelStore(db.pg);
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`
    TRUNCATE label_store.subject, label_store.change, label_store.record_failure,
      label_store.erased_subject, label_store.erased_owner RESTART IDENTITY CASCADE;
    TRUNCATE "ScanLabelCopyObject", "AppealDecisionRecord", "Image" RESTART IDENTITY CASCADE;
  `);
  await db.pg.query(
    `INSERT INTO "Image" ("id", "userId", "url", "pHash", "meta")
     VALUES ($1, $2, 'u-501', 77, '{"prompt": "a cat"}')`,
    [IMAGE, OWNER]
  );
  await db.pg.query(`INSERT INTO "ScanLabelItem" ("id", "imageId") VALUES ($1, $2)`, [ITEM, IMAGE]);
});

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.pg.query<T>(sql, params)).rows;

const vote = (userId: number, block: boolean, createdAt = '2026-01-01T00:00:00Z') =>
  db.pg.query(
    `INSERT INTO "ScanLabelVote" ("itemId", "userId", "block", "reason", "reasonComment", "createdAt")
     VALUES ($1, $2, $3, 'reason-a', 'note-a', $4::timestamptz)`,
    [ITEM, userId, block, createdAt]
  );

const flag = (workflowId = 'wf-1', flaggedAt = '2026-01-01T00:00:00Z') =>
  db.pg.query(
    `INSERT INTO "ScanLabelFlag" ("itemId", "source", "flaggerVersion", "workflowId", "flaggedAt")
     VALUES ($1, 'orchestrator-scan', 'scanner@1', $2, $3::timestamptz)`,
    [ITEM, workflowId, flaggedAt]
  );

const label = (
  value: string,
  sourceRef: string,
  opts: { user?: number; kind?: string; version?: number; at?: string; hash?: string } = {}
) =>
  db.pg.query(
    `SELECT label_store.record_label(
       p_subject_type => 'image', p_subject_id => '${IMAGE}', p_content_hash => $1,
       p_family => 'test', p_question => 'image.block', p_value => $2,
       p_labeller_kind => $3, p_labeller_user_id => $4, p_source_ref => $5,
       p_labelled_at => $6::timestamptz, p_question_version => $7,
       p_snapshot => '{"url": "u-501"}') AS id`,
    [
      opts.hash ?? HASH,
      value,
      opts.kind ?? 'moderator',
      opts.user ?? MODS[0],
      sourceRef,
      opts.at ?? '2026-01-01T00:00:00Z',
      opts.version ?? 1,
    ]
  );

const consensus = async (version = 1) =>
  (
    await rows<{
      outcome: string | null;
      humanLabels: number;
      agreeing: number;
      trainable: boolean;
      modelValue: string | null;
      modelAgrees: boolean | null;
    }>(
      `SELECT * FROM label_store.consensus WHERE "question" = 'image.block' AND "questionVersion" = $1`,
      [version]
    )
  )[0];

const kinds = async () =>
  (await rows<{ kind: string }>(`SELECT "kind" FROM label_store.change ORDER BY "id"`)).map(
    (c) => c.kind
  );

const failures = () => rows<{ sourceRef: string; error: string }>(`SELECT * FROM label_store.record_failure`);

describe('person hashes', () => {
  it('keys the hash and keeps owner and labeller kinds apart', async () => {
    const [{ key }] = await rows<{ key: string }>(`SELECT "key" FROM label_store.secret`);
    const [h] = await rows<{ owner: string; labeller: string }>(
      `SELECT label_store.person_hash('owner', 21) AS owner, label_store.person_hash('labeller', 21) AS labeller`
    );

    expect(h.owner).toBe(sha256(`${key}:owner:21`));
    expect(h.labeller).toBe(sha256(`${key}:labeller:21`));
    expect(h.owner).not.toBe(h.labeller);
    expect(h.labeller).not.toBe(sha256('labeller:21'));
  });

  it('re-applying the migration keeps the key, so hashes stay stable', async () => {
    const before = await rows(`SELECT label_store.person_hash('owner', 5) AS h`);
    await db.pg.exec(readFileSync(LABEL_STORE_MIGRATION, 'utf8'));

    expect(await rows(`SELECT label_store.person_hash('owner', 5) AS h`)).toEqual(before);
    expect(await rows(`SELECT count(*)::int AS n FROM label_store.secret`)).toEqual([{ n: 1 }]);
  });
});

describe('consensus', () => {
  it('counts each person once with their latest answer, by when they answered', async () => {
    await label('block', 'a-1', { user: MODS[0] });
    await label('block', 'b-1', { user: MODS[1] });
    await label('clear', 'c-1', { user: MODS[2] });
    // MODS[0] changes their answer; then a late-arriving older answer must not win.
    await label('clear', 'a-2', { user: MODS[0], at: '2026-01-03T00:00:00Z' });
    await label('block', 'a-0', { user: MODS[0], at: '2026-01-02T00:00:00Z' });

    expect(await consensus()).toMatchObject({ outcome: 'clear', humanLabels: 3, agreeing: 2 });
  });

  it('a tie for the top answer has no outcome', async () => {
    await label('block', 'a', { user: MODS[0] });
    await label('block', 'b', { user: MODS[1] });
    await label('clear', 'c', { user: MODS[2] });
    await label('clear', 'd', { user: MODS[3] });

    expect(await consensus()).toMatchObject({ outcome: null, humanLabels: 4, trainable: false });
  });

  it('counts knights and leaves appeal outcomes out', async () => {
    await label('clear', 'k-1', { user: MODS[0], kind: 'knight' });
    await label('clear', 'k-2', { user: MODS[1], kind: 'knight' });
    await label('clear', 'm-1', { user: MODS[2] });
    await label('block', 'ap-1', { user: MODS[3], kind: 'appeal' });

    expect(await consensus()).toMatchObject({ outcome: 'clear', humanLabels: 3, agreeing: 3 });
  });

  it('keeps question versions apart', async () => {
    for (const m of MODS.slice(0, 3)) await label('clear', `v1-${m}`, { user: m });
    await label('block', 'v2-a', { user: MODS[0], version: 2 });

    expect(await consensus(1)).toMatchObject({ humanLabels: 3, outcome: 'clear' });
    // No rule for version 2, so it never becomes trainable.
    expect(await consensus(2)).toMatchObject({ humanLabels: 1, outcome: null, trainable: false });
  });

  it('a prediction arriving after the votes updates the consensus, and the latest one counts', async () => {
    for (const m of MODS.slice(0, 3)) await vote(m, true);
    const before = await kinds();
    await flag('wf-old', '2026-01-01T00:00:00Z');
    await flag('wf-new', '2026-01-02T00:00:00Z');
    await db.pg.query(
      `SELECT label_store.submit_prediction('image', '${IMAGE}', $1, 'image.block', 'clear', 'm@2',
         'late', '2026-01-01T12:00:00Z')`,
      [HASH]
    );

    expect(await consensus()).toMatchObject({ outcome: 'block', modelValue: 'block', modelAgrees: true });
    expect((await kinds()).slice(before.length)).toEqual([
      'prediction',
      'consensus',
      'prediction',
      'prediction',
    ]);
  });

  it('pipeline_failures holds only subjects the model got wrong, not ones it never judged', async () => {
    for (const m of MODS.slice(0, 3)) await vote(m, false);
    expect(await consensus()).toMatchObject({ trainable: true, modelAgrees: null });
    expect(await rows(`SELECT * FROM label_store.pipeline_failures`)).toEqual([]);

    await flag();
    expect(await rows(`SELECT "siteId" FROM label_store.pipeline_failures`)).toEqual([
      { siteId: String(IMAGE) },
    ]);
  });
});

describe('what the source rows carry', () => {
  it('takes labelledAt, the reason note and the snapshot from the vote and its image', async () => {
    await vote(MODS[0], true, '2026-02-03T04:05:06Z');

    const [l] = await rows<{ labelledAt: Date; reasonNote: string }>(
      `SELECT * FROM label_store.labels_feed`
    );
    expect(l.labelledAt.toISOString()).toBe('2026-02-03T04:05:06.000Z');
    expect(l.reasonNote).toBe('note-a');
    for (const m of MODS.slice(1, 3)) await vote(m, true);
    expect(await rows(`SELECT "snapshot", "pHash" FROM label_store.training_examples`)).toEqual([
      { snapshot: { url: 'u-501', prompt: 'a cat' }, pHash: 77 },
    ]);
  });

  it('takes predictedAt from the flag', async () => {
    await flag('wf-1', '2026-03-04T05:06:07Z');

    const [p] = await rows<{ predictedAt: Date }>(`SELECT * FROM label_store.predictions_feed`);
    expect(p.predictedAt.toISOString()).toBe('2026-03-04T05:06:07.000Z');
  });

  it('a new upload is a new subject', async () => {
    await vote(MODS[0], true);
    await db.pg.query(`UPDATE "Image" SET "url" = 'u-501-b' WHERE "id" = $1`, [IMAGE]);
    await vote(MODS[1], true);

    expect(
      await rows(`SELECT "contentHash" FROM label_store.subject ORDER BY "id"`)
    ).toEqual([{ contentHash: HASH }, { contentHash: sha256('u-501-b') }]);
  });

  it('a repeat judgement on a complete subject writes no subject change', async () => {
    await vote(MODS[0], true);
    await vote(MODS[1], true);

    expect(await kinds()).toEqual(['label', 'consensus', 'label', 'consensus']);
  });

  it('a judgement that fills a missing field is a subject change', async () => {
    await db.pg.query(
      `SELECT label_store.submit_prediction('image', '${IMAGE}', $1, 'image.block', 'block', 'm@1', 'p-1')`,
      [HASH]
    );
    expect(await rows(`SELECT "snapshot" FROM label_store.subject`)).toEqual([{ snapshot: null }]);
    await vote(MODS[0], true);

    expect(await rows(`SELECT "snapshot" FROM label_store.subject`)).toEqual([
      { snapshot: { url: 'u-501', prompt: 'a cat' } },
    ]);
    expect(await kinds()).toEqual(['prediction', 'subject', 'label', 'consensus']);
  });
});

describe('failures are logged, and the source write still lands', () => {
  it('a prediction the store refuses', async () => {
    await db.pg.exec(
      `ALTER TABLE label_store.prediction ADD CONSTRAINT forced_failure CHECK ("value" <> 'block')`
    );
    try {
      await flag();

      expect(await rows(`SELECT * FROM "ScanLabelFlag"`)).toHaveLength(1);
      expect(await rows(`SELECT * FROM label_store.prediction`)).toEqual([]);
      expect(await failures()).toEqual([
        expect.objectContaining({ sourceRef: 'ScanLabelFlag:wf-1', error: expect.stringContaining('forced_failure') }),
      ]);
    } finally {
      await db.pg.exec(`ALTER TABLE label_store.prediction DROP CONSTRAINT forced_failure`);
    }
  });

  it('a flag whose image cannot be found', async () => {
    await db.pg.exec(`ALTER TABLE "ScanLabelItem" DROP CONSTRAINT "ScanLabelItem_imageId_fkey"`);
    try {
      await db.pg.query(`UPDATE "ScanLabelItem" SET "imageId" = 999 WHERE "id" = $1`, [ITEM]);
      await flag();

      expect(await rows(`SELECT * FROM "ScanLabelFlag"`)).toHaveLength(1);
      expect(await failures()).toEqual([
        expect.objectContaining({ sourceRef: 'ScanLabelFlag:wf-1', error: 'image not found' }),
      ]);
    } finally {
      await db.pg.query(`UPDATE "ScanLabelItem" SET "imageId" = $1 WHERE "id" = $2`, [IMAGE, ITEM]);
      await db.pg.exec(
        `ALTER TABLE "ScanLabelItem" ADD CONSTRAINT "ScanLabelItem_imageId_fkey"
         FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE`
      );
    }
  });

  it('every function on a site write path waits at most 2s for a lock', async () => {
    const fns = await rows<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'label_store' AND (p.proname LIKE 'from\\_%' OR p.proname LIKE 'record\\_%'
         OR p.proname = 'upsert_subject' OR p.proname = 'trg_appeal_decision_deleted')
         AND NOT ('lock_timeout=2s' = ANY (coalesce(p.proconfig, '{}')))`
    );
    const all = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'label_store' AND 'lock_timeout=2s' = ANY (coalesce(p.proconfig, '{}'))`
    );

    expect(fns).toEqual([]);
    expect(all[0].n).toBe(9);
  });
});

describe('exclusion', () => {
  const excludeImage = (reason: string) =>
    db.pg.query(`SELECT label_store.exclude('image', '${IMAGE}', $1)`, [reason]);

  it('keeps the judgements, drops content and bytes itself, and untrains', async () => {
    for (const m of MODS.slice(0, 3)) await vote(m, false);
    await db.pg.query(
      `UPDATE label_store.subject SET "bytesRef" = 'b', "bytesExpireAt" = now() + interval '1 day'`
    );
    await excludeImage('removed');

    expect(await rows(`SELECT * FROM label_store.subject`)).toEqual([
      expect.objectContaining({ excludedReason: 'removed', snapshot: null, bytesRef: null, bytesExpireAt: null }),
    ]);
    expect(await consensus()).toMatchObject({ trainable: false, outcome: 'clear' });
    expect(await rows(`SELECT "excluded" FROM label_store.labels_feed`)).toEqual(
      Array(3).fill({ excluded: true })
    );
  });

  it('a later label brings back neither the snapshot nor trainability', async () => {
    for (const m of MODS.slice(0, 3)) await vote(m, false);
    await excludeImage('safety');
    await vote(MODS[3], false);

    expect(await rows(`SELECT "snapshot" FROM label_store.subject`)).toEqual([{ snapshot: null }]);
    expect(await consensus()).toMatchObject({ humanLabels: 4, trainable: false });
    expect(await rows(`SELECT * FROM label_store.training_examples`)).toEqual([]);
  });

  it('a copy after exclusion is ignored', async () => {
    await vote(MODS[0], false);
    await excludeImage('safety');
    await db.pg.query(
      `UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = 'k/1', "copiedAt" = now()`
    );

    expect(await rows(`SELECT "bytesRef" FROM label_store.subject`)).toEqual([{ bytesRef: null }]);
  });

  it('deleting an appeal record takes its image out of training', async () => {
    await db.pg.query(
      `INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "imageUrl", "nsfwLevel", "decision", "decidedAt")
       VALUES (900, $1, 'u-501', 16, 'Approved', now()), (901, 502, 'u-502', 1, 'Rejected', now())`,
      [IMAGE]
    );
    await db.pg.query(`DELETE FROM "AppealDecisionRecord" WHERE "appealId" = 900`);

    expect(
      await rows(`SELECT "subjectId", "excludedReason" FROM label_store.subject ORDER BY "subjectId"`)
    ).toEqual([
      { subjectId: String(IMAGE), excludedReason: 'removed' },
      { subjectId: '502', excludedReason: null },
    ]);
  });
});

describe('erasure', () => {
  it('deletes the subject, and nothing can bring it back', async () => {
    await vote(MODS[0], false);
    const [{ n }] = await rows<{ n: number }>(
      `SELECT label_store.exclude('image', '${IMAGE}', 'erasure') AS n`
    );
    expect(n).toBe(1);
    expect(await rows(`SELECT * FROM label_store.label`)).toEqual([]);

    await vote(MODS[1], false);
    await db.pg.exec(`TRUNCATE label_store.record_failure`);
    await db.pg.query(`SELECT * FROM label_store.backfill()`);

    expect(await rows(`SELECT * FROM label_store.subject`)).toEqual([]);
    // Both votes are replayed and both refused.
    expect((await failures()).map((f) => f.error)).toEqual(
      Array(2).fill(expect.stringContaining('was erased'))
    );
    await expect(
      db.pg.query(
        `SELECT label_store.submit_prediction('image', '${IMAGE}', $1, 'image.block', 'block', 'm@1', 'p')`,
        [HASH]
      )
    ).rejects.toThrow(/was erased/);
  });

  it('an erased owner stays erased for content the store had not seen', async () => {
    await db.pg.query(`SELECT label_store.erase_owner(${OWNER})`);
    await vote(MODS[0], false);

    expect(await rows(`SELECT * FROM label_store.subject`)).toEqual([]);
    expect((await failures()).map((f) => f.error)).toEqual([
      expect.stringContaining('owner of subject'),
    ]);
  });

  it('an appeal subject recorded after its image is gone has no owner hash', async () => {
    await db.pg.query(`DELETE FROM "Image" WHERE "id" = $1`, [IMAGE]);
    await db.pg.query(
      `INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "imageUrl", "nsfwLevel", "decision", "decidedAt")
       VALUES (900, $1, 'u-501', 16, 'Rejected', now())`,
      [IMAGE]
    );

    // erase_owner cannot reach it; exclude('image', id, 'erasure') can.
    expect(await rows(`SELECT "ownerHash" FROM label_store.subject`)).toEqual([{ ownerHash: null }]);
    expect(await rows(`SELECT label_store.erase_owner(${OWNER}) AS n`)).toEqual([{ n: 0 }]);
  });
});

describe('bytes', () => {
  it('training_examples hides a pointer whose bytes have expired', async () => {
    for (const m of MODS.slice(0, 3)) await vote(m, false);
    await db.pg.query(
      `UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = 'k/1', "copiedAt" = now() - interval '31 days'`
    );

    expect(await rows(`SELECT "bytesRef" FROM label_store.subject`)).toEqual([
      { bytesRef: 'scan-label-copy:k/1' },
    ]);
    expect(await rows(`SELECT "bytesRef", "bytesExpireAt" FROM label_store.training_examples`)).toEqual([
      { bytesRef: null, bytesExpireAt: null },
    ]);
    expect(await kinds()).toContain('subject');
  });

  it('a copy fires once, and a re-update of a copied item changes nothing', async () => {
    await vote(MODS[0], false);
    const copy = () =>
      db.pg.query(
        `UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = 'k/1', "copiedAt" = now()`
      );
    await copy();
    const after = await kinds();
    await copy();

    expect(after.filter((k) => k === 'subject')).toHaveLength(1);
    expect(await kinds()).toEqual(after);
  });

  it('a withdrawal fires once, on the first withdrawnAt only', async () => {
    await vote(MODS[0], false);
    await db.pg.query(
      `UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = 'k/1', "copiedAt" = now()`
    );
    await db.pg.query(
      `INSERT INTO "ScanLabelCopyObject" ("key", "itemId", "imageId") VALUES ('k/1', $1, $2)`,
      [ITEM, IMAGE]
    );
    await db.pg.query(`UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now(), "withdrawReason" = 'gone'`);
    expect(await rows(`SELECT "bytesRef" FROM label_store.subject`)).toEqual([{ bytesRef: null }]);
    const after = await kinds();
    await db.pg.query(`UPDATE "ScanLabelCopyObject" SET "withdrawReason" = 'excluded'`);

    expect(await kinds()).toEqual(after);
    expect(await rows(`SELECT "excludedAt" FROM label_store.subject`)).toEqual([{ excludedAt: null }]);
  });
});

describe('the change feed', () => {
  it('carries txid, and shows a transaction only once it is older than every running one', async () => {
    await db.pg.exec('BEGIN');
    try {
      await vote(MODS[0], false);
      expect(await rows(`SELECT * FROM label_store.change`)).not.toEqual([]);
      expect(await rows(`SELECT * FROM label_store.changes_feed`)).toEqual([]);
    } finally {
      await db.pg.exec('COMMIT');
    }

    const feed = await rows<{ txid: bigint; kind: string }>(
      `SELECT "txid", "kind" FROM label_store.changes_feed ORDER BY "txid", "id"`
    );
    expect(feed.map((c) => c.kind)).toEqual(['label', 'consensus']);
    expect(new Set(feed.map((c) => c.txid)).size).toBe(1);
  });
});

describe('backfill', () => {
  const seed = async () => {
    await flag();
    for (const m of MODS.slice(0, 3)) await vote(m, false);
    await db.pg.query(
      `INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "imageUrl", "nsfwLevel", "decision", "decidedAt")
       VALUES (900, $1, 'u-501', 16, 'Approved', '2026-01-05T00:00:00Z')`,
      [IMAGE]
    );
    await db.pg.query(
      `UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = 'k/1', "copiedAt" = now()`
    );
    await db.pg.exec(`
      INSERT INTO "Image" ("id", "userId", "url") VALUES (502, 12, 'u-502');
      INSERT INTO "ScanLabelItem" ("id", "imageId", "copyState", "copyKey", "copiedAt") VALUES (8, 502, NULL, NULL, NULL);
      INSERT INTO "ScanLabelVote" ("itemId", "userId", "block") VALUES (8, 21, true);
      UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = 'k/2', "copiedAt" = now() WHERE "id" = 8;
      INSERT INTO "ScanLabelCopyObject" ("key", "itemId", "imageId") VALUES ('k/2', 8, 502);
      UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now(), "withdrawReason" = 'excluded';
    `);
  };
  const state = async () => ({
    labels: await rows(`SELECT "sourceRef", "value" FROM label_store.label ORDER BY "sourceRef"`),
    predictions: await rows(`SELECT "sourceRef" FROM label_store.prediction ORDER BY "sourceRef"`),
    subjects: await rows(
      `SELECT "subjectId", "bytesRef", "excludedReason", "snapshot" IS NULL AS "noSnapshot"
       FROM label_store.subject ORDER BY "subjectId"`
    ),
  });

  it('backfill() rebuilds appeals, copies and withdrawals too', async () => {
    await seed();
    const live = await state();
    expect(live.subjects).toEqual([
      { subjectId: String(IMAGE), bytesRef: 'scan-label-copy:k/1', excludedReason: null, noSnapshot: false },
      { subjectId: '502', bytesRef: null, excludedReason: 'safety', noSnapshot: true },
    ]);
    await db.pg.exec(`TRUNCATE label_store.subject, label_store.change RESTART IDENTITY CASCADE`);

    await db.pg.query(`SELECT * FROM label_store.backfill()`);

    expect(await state()).toEqual(live);
    expect(await failures()).toEqual([]);
  });

  it('backfill_batches() commits in batches and rebuilds the same store', async () => {
    await seed();
    const live = await state();
    await db.pg.exec(`TRUNCATE label_store.subject, label_store.change RESTART IDENTITY CASCADE`);

    await db.pg.exec(`CALL label_store.backfill_batches(1)`);
    expect(await state()).toEqual(live);
    const changes = await kinds();
    await db.pg.exec(`CALL label_store.backfill_batches(1)`);
    expect(await state()).toEqual(live);
    expect(await kinds()).toEqual(changes);
    expect(await failures()).toEqual([]);
  });
});

describe('the reader role', () => {
  beforeAll(async () => {
    await db.pg.exec(`DO $$ BEGIN CREATE ROLE label_reader; EXCEPTION WHEN duplicate_object THEN END $$;`);
    const grant = readFileSync(LABEL_STORE_MIGRATION, 'utf8').match(
      /DO \$\$\r?\nBEGIN\r?\n {2}IF EXISTS[\s\S]*?\r?\n\$\$;/
    );
    if (!grant) throw new Error('grant block not found in the migration');
    await db.pg.exec(grant[0]);
  });

  it('no routine in the store is executable by the reader or by PUBLIC', async () => {
    const routines = await rows<{ name: string; reader: boolean; public: boolean }>(
      `SELECT p.proname AS name,
         has_function_privilege('label_reader', p.oid, 'EXECUTE') AS reader,
         EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 WHERE a.grantee = 0) AS public
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'label_store'`
    );

    expect(routines.length).toBeGreaterThan(20);
    expect(routines.filter((r) => r.reader || r.public)).toEqual([]);
  });

  it('the reader can select exactly the five views, and no view exposes an owner hash', async () => {
    const grants = await rows<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'label_reader' ORDER BY table_name`
    );
    expect(grants).toEqual(
      ['changes_feed', 'labels_feed', 'pipeline_failures', 'predictions_feed', 'training_examples'].map(
        (table_name) => ({ table_name, privilege_type: 'SELECT' })
      )
    );
    expect(
      await rows(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'label_store' AND column_name = 'ownerHash'
           AND table_name IN (SELECT table_name FROM information_schema.role_table_grants
                              WHERE grantee = 'label_reader')`
      )
    ).toEqual([]);
    // Twin: the column exists to be found.
    expect(
      await rows(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'label_store' AND table_name = 'subject' AND column_name = 'ownerHash'`
      )
    ).toHaveLength(1);
  });
});

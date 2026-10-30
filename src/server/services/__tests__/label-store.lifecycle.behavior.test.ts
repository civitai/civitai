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
    TRUNCATE "ScanLabelCopyObject", "AppealDecisionRecord", "Image", "CsamReport", "Appeal"
      RESTART IDENTITY CASCADE;
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

const failures = () =>
  rows<{ sourceRef: string; error: string }>(`SELECT * FROM label_store.record_failure`);

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
    // a-0 arrives last but is older than a-2.
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

    expect(await consensus()).toMatchObject({
      outcome: 'block',
      modelValue: 'block',
      modelAgrees: true,
    });
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

    expect(await rows(`SELECT "contentHash" FROM label_store.subject ORDER BY "id"`)).toEqual([
      { contentHash: HASH },
      { contentHash: sha256('u-501-b') },
    ]);
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
        expect.objectContaining({
          sourceRef: 'ScanLabelFlag:wf-1',
          error: expect.stringContaining('forced_failure'),
        }),
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
      expect.objectContaining({
        excludedReason: 'removed',
        pHash: null,
        snapshot: null,
        bytesRef: null,
        bytesExpireAt: null,
      }),
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

  it('a later label that fills another field still leaves the content out', async () => {
    // Judged before the image row exists, so the subject has no owner yet.
    await db.pg.query(
      `SELECT label_store.submit_prediction('image', '601', $1, 'image.block', 'block', 'm@1', 'p-1')`,
      [sha256('u-601')]
    );
    await db.pg.query(`SELECT label_store.exclude('image', '601', 'safety')`);
    await db.pg.exec(`
      INSERT INTO "Image" ("id", "userId", "url", "pHash", "meta") VALUES (601, 12, 'u-601', 78, '{}');
      INSERT INTO "ScanLabelItem" ("id", "imageId") VALUES (9, 601);
      INSERT INTO "ScanLabelVote" ("itemId", "userId", "block") VALUES (9, 21, true);
    `);

    expect(
      await rows(
        `SELECT "ownerHash" IS NOT NULL AS owned, "pHash", "snapshot" FROM label_store.subject`
      )
    ).toEqual([{ owned: true, pHash: null, snapshot: null }]);
  });

  it.each(
    [
      ['flagged for review', `UPDATE "Image" SET "needsReview" = 'csam'`],
      ['blocked', `UPDATE "Image" SET "blockedFor" = 'CSAM'`],
      ['named by a report', `INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 501}]')`],
      ['owned by a reported user', `INSERT INTO "CsamReport" ("userId") VALUES (11)`],
      [
        'named by a report as a string id',
        `INSERT INTO "CsamReport" ("images") VALUES ('[{"id": "501"}]')`,
      ],
      [
        'sharing its file with a flagged image',
        `INSERT INTO "Image" ("id", "userId", "url", "needsReview") VALUES (502, 12, 'u-501', 'csam')`,
      ],
    ].flatMap(([state, setup]) => [
      [state, 'votes', setup],
      [state, 'a flag', setup],
      [state, 'a prediction', setup],
    ])
  )('an image already %s is excluded when %s land', async (_, judgement, setup) => {
    await db.pg.exec(setup);
    if (judgement === 'votes') for (const m of MODS.slice(0, 3)) await vote(m, false);
    else if (judgement === 'a flag') await flag();
    else
      await db.pg.query(
        `SELECT label_store.submit_prediction('image', '${IMAGE}', $1, 'image.block', 'block', 'm@1', 'p-1')`,
        [HASH]
      );

    expect(
      await rows(`SELECT "excludedReason", "snapshot", "pHash" FROM label_store.subject`)
    ).toEqual([{ excludedReason: 'safety', snapshot: null, pHash: null }]);
    expect(await rows(`SELECT * FROM label_store.training_examples`)).toEqual([]);
    expect(await failures()).toEqual([]);
  });

  it.each([
    [
      'a clean image',
      `INSERT INTO "Image" ("id", "userId", "url") VALUES (502, 12, 'u-501')`,
      null,
    ],
    [
      'a flagged image with a lower id',
      `INSERT INTO "Image" ("id", "userId", "url", "needsReview") VALUES (400, 12, 'u-501', 'csam')`,
      'safety',
    ],
  ])('an image sharing its file with %s, when votes land: %s', async (_, setup, reason) => {
    await db.pg.exec(setup);
    for (const m of MODS.slice(0, 3)) await vote(m, false);

    expect(await rows(`SELECT "excludedReason" FROM label_store.subject`)).toEqual([
      { excludedReason: reason },
    ]);
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
      await rows(
        `SELECT "subjectId", "excludedReason" FROM label_store.subject ORDER BY "subjectId"`
      )
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

  it('an appeal subject recorded after its image is gone is still erasable by owner', async () => {
    await db.pg.query(`DELETE FROM "Image" WHERE "id" = $1`, [IMAGE]);
    await db.pg.query(`INSERT INTO "Appeal" ("id", "userId") VALUES (900, $1), (901, 12)`, [OWNER]);
    await db.pg.query(
      `INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "imageUrl", "nsfwLevel", "decision", "decidedAt")
       VALUES (900, $1, 'u-501', 16, 'Rejected', now()), (901, 502, 'u-502', 1, 'Rejected', now())`,
      [IMAGE]
    );

    expect(await rows(`SELECT label_store.erase_owner(${OWNER}) AS n`)).toEqual([{ n: 1 }]);
    expect(await rows(`SELECT "subjectId" FROM label_store.subject`)).toEqual([
      { subjectId: '502' },
    ]);
  });

  it('a writer holds the subject and owner locks shared, and erasure takes them exclusively', async () => {
    const advisory = () =>
      rows<{ mode: string }>(`SELECT mode FROM pg_locks WHERE locktype = 'advisory' ORDER BY mode`);
    // The eraser must lock the keys the writer locks, or neither waits for the other.
    const keys = async () =>
      (
        await rows<{ key: string }>(
          `SELECT classid::text || '/' || objid::text AS key FROM pg_locks
           WHERE locktype = 'advisory' ORDER BY 1`
        )
      ).map((r) => r.key);
    let writer: string[];
    await db.pg.exec('BEGIN');
    try {
      await vote(MODS[0], false);
      expect(await advisory()).toEqual([{ mode: 'ShareLock' }, { mode: 'ShareLock' }]);
      writer = await keys();
    } finally {
      await db.pg.exec('COMMIT');
    }
    // erase_owner locks the owner and each of its subjects.
    await db.pg.exec('BEGIN');
    try {
      await db.pg.query(`SELECT label_store.erase_owner(${OWNER})`);
      expect(await advisory()).toEqual([{ mode: 'ExclusiveLock' }, { mode: 'ExclusiveLock' }]);
      expect(await keys()).toEqual(writer);
    } finally {
      await db.pg.exec('COMMIT');
    }
    await db.pg.exec('BEGIN');
    try {
      await db.pg.query(`SELECT label_store.exclude('image', '${IMAGE}', 'erasure')`);
      expect(writer).toContain((await keys())[0]);
    } finally {
      await db.pg.exec('COMMIT');
    }
    await db.pg.exec('BEGIN');
    try {
      await db.pg.query(`SELECT label_store.exclude('image', '999', 'erasure')`);
      expect(await advisory()).toEqual([{ mode: 'ExclusiveLock' }]);
    } finally {
      await db.pg.exec('COMMIT');
    }
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
    expect(
      await rows(`SELECT "bytesRef", "bytesExpireAt" FROM label_store.training_examples`)
    ).toEqual([{ bytesRef: null, bytesExpireAt: null }]);
    expect(await kinds()).toContain('subject');
  });

  it.each([
    ['29 days', true],
    ['30 days 1 hour', false],
  ])('a copy made %s ago is visible: %s', async (age, visible) => {
    for (const m of MODS.slice(0, 3)) await vote(m, false);
    await db.pg.query(
      `UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = 'k/1', "copiedAt" = now() - $1::interval`,
      [age]
    );

    expect(await rows(`SELECT "bytesRef" FROM label_store.training_examples`)).toEqual([
      { bytesRef: visible ? 'scan-label-copy:k/1' : null },
    ]);
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
    await db.pg.query(
      `UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now(), "withdrawReason" = 'gone'`
    );
    expect(await rows(`SELECT "bytesRef" FROM label_store.subject`)).toEqual([{ bytesRef: null }]);
    const after = await kinds();
    await db.pg.query(`UPDATE "ScanLabelCopyObject" SET "withdrawReason" = 'excluded'`);

    expect(await kinds()).toEqual(after);
    expect(await rows(`SELECT "excludedAt" FROM label_store.subject`)).toEqual([
      { excludedAt: null },
    ]);
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
      {
        subjectId: String(IMAGE),
        bytesRef: 'scan-label-copy:k/1',
        excludedReason: null,
        noSnapshot: false,
      },
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
    await db.pg.exec(
      `DO $$ BEGIN CREATE ROLE label_reader; EXCEPTION WHEN duplicate_object THEN END $$;`
    );
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

  it('every reader view is a security barrier, and the feed still pages on its index', async () => {
    expect(
      await rows(
        `SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'label_store' AND c.relkind = 'v' ORDER BY c.relname`
      )
    ).toEqual(
      [
        'changes_feed',
        'labels_feed',
        'pipeline_failures',
        'predictions_feed',
        'training_examples',
      ].map((relname) => ({ relname, reloptions: ['security_barrier=true'] }))
    );
    await db.pg.exec('SET enable_seqscan = off; SET ROLE label_reader');
    try {
      const plan = await rows<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT * FROM label_store.changes_feed WHERE ("txid", "id") > (0, 0) ORDER BY "txid", "id" LIMIT 10`
      );
      const text = plan.map((p) => p['QUERY PLAN']).join(' | ');
      expect(text).toContain('change_txid_idx');
      expect(text).toMatch(/Index Cond: [^|]*ROW\(txid, id\) > ROW\(0, 0\)/);
    } finally {
      await db.pg.exec('RESET ROLE; RESET enable_seqscan');
    }
  });

  it('the reader can select exactly the five views, and no view exposes an owner hash', async () => {
    const grants = await rows<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'label_reader' ORDER BY table_name`
    );
    expect(grants).toEqual(
      [
        'changes_feed',
        'labels_feed',
        'pipeline_failures',
        'predictions_feed',
        'training_examples',
      ].map((table_name) => ({ table_name, privilege_type: 'SELECT' }))
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

describe('erasure tombstones', () => {
  it('an erased subject is not rebuilt from a record that outlived its image and appeal', async () => {
    await db.pg.query(`INSERT INTO "Appeal" ("id", "userId") VALUES (900, $1)`, [OWNER]);
    await db.pg.query(
      `INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "imageUrl", "nsfwLevel", "decision", "decidedAt")
       VALUES (900, $1, 'u-501', 16, 'Rejected', now())`,
      [IMAGE]
    );
    await db.pg.query(`SELECT label_store.erase_owner(${OWNER})`);
    // With the image and the appeal gone the replay has no owner, so only the subject tombstone stops it.
    await db.pg.query(`DELETE FROM "Image" WHERE "id" = $1`, [IMAGE]);
    await db.pg.query(`DELETE FROM "Appeal"`);
    await db.pg.query(`SELECT * FROM label_store.backfill()`);

    expect(await rows(`SELECT * FROM label_store.subject`)).toEqual([]);
  });
});

describe('batches and triggers', () => {
  it('backfill_batches commits every p_batch rows of every source, 25 by default', async () => {
    await db.pg.exec(`
      INSERT INTO "Image" ("id", "userId", "url") VALUES (502, 12, 'u-502');
      INSERT INTO "ScanLabelItem" ("id", "imageId") VALUES (8, 502);
    `);
    for (const [item, wf] of [
      [ITEM, 'wf-1'],
      [8, 'wf-2'],
    ] as const)
      await db.pg.query(
        `INSERT INTO "ScanLabelFlag" ("itemId", "source", "flaggerVersion", "workflowId", "flaggedAt")
         VALUES ($1, 'orchestrator-scan', 'scanner@1', $2, now())`,
        [item, wf]
      );
    for (const m of MODS.slice(0, 2)) await vote(m, false);
    await db.pg.query(
      `INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "imageUrl", "nsfwLevel", "decision", "decidedAt")
       VALUES (900, 501, 'u-501', 16, 'Rejected', now()), (901, 502, 'u-502', 1, 'Rejected', now())`
    );
    await db.pg.exec(`
      UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = 'k/' || "id", "copiedAt" = now();
      INSERT INTO "ScanLabelCopyObject" ("key", "itemId", "imageId") VALUES ('k/7', 7, 501), ('k/8', 8, 502);
      UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now(), "withdrawReason" = 'gone';
    `);
    await db.pg.exec(`TRUNCATE label_store.subject, label_store.change RESTART IDENTITY CASCADE`);

    await db.pg.exec(`CALL label_store.backfill_batches(1)`);

    // Two source rows of each kind, so a loop that never commits shows as one transaction.
    expect(
      await rows(
        `SELECT CASE WHEN c."kind" = 'label' THEN l."family" ELSE c."kind" END AS source,
           count(DISTINCT c."txid")::int AS n
         FROM label_store.change c LEFT JOIN label_store.label l ON l."id" = c."refId" AND c."kind" = 'label'
         WHERE c."kind" IN ('label', 'prediction', 'subject')
         GROUP BY 1 ORDER BY 1`
      )
    ).toEqual([
      { source: 'appeal', n: 2 },
      { source: 'prediction', n: 2 },
      { source: 'scan_label', n: 2 },
      { source: 'subject', n: 4 },
    ]);
    expect(
      await rows(
        `SELECT pg_get_function_arguments(p.oid) AS args FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'label_store' AND p.proname = 'backfill_batches'`
      )
    ).toEqual([{ args: 'IN p_batch integer DEFAULT 25' }]);
  });

  it('every trigger is created in its own transaction with a 5s lock timeout', () => {
    // PGlite has one connection, so the timeout is pinned by the file's text.
    const sql = readFileSync(LABEL_STORE_MIGRATION, 'utf8');
    const triggers = sql.match(/^CREATE OR REPLACE TRIGGER \w+\r?$/gm) ?? [];
    const wrapped =
      sql.match(/BEGIN;\r?\nSET LOCAL lock_timeout = '5s';\r?\nCREATE OR REPLACE TRIGGER \w+/g) ??
      [];

    expect(triggers).toHaveLength(6);
    expect(wrapped).toHaveLength(triggers.length);
  });

  it('withdrawing an old copy leaves a newer copy in place', async () => {
    await vote(MODS[0], false);
    const copy = (key: string) =>
      db.pg.query(
        `UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = $1, "copiedAt" = now()`,
        [key]
      );
    await copy('k/1');
    await db.pg.query(`UPDATE "ScanLabelItem" SET "copyState" = NULL`);
    await copy('k/2');
    await db.pg.query(
      `INSERT INTO "ScanLabelCopyObject" ("key", "itemId", "imageId") VALUES ('k/1', $1, $2)`,
      [ITEM, IMAGE]
    );
    await db.pg.query(
      `UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now(), "withdrawReason" = 'gone'`
    );

    expect(await rows(`SELECT "bytesRef" FROM label_store.subject`)).toEqual([
      { bytesRef: 'scan-label-copy:k/2' },
    ]);
  });
});

describe('source mappings', () => {
  it('an appeal decision is an appeal-kind label with the record time and the record snapshot', async () => {
    await db.pg.query(`INSERT INTO "Appeal" ("id", "userId") VALUES (900, $1)`, [OWNER]);
    await db.pg.query(
      `INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "imageUrl", "pHash", "nsfwLevel",
         "nsfwLevelReason", "aiNsfwLevel", "blockedFor", "decision", "decidedAt")
       VALUES (900, $1, 'u-501', 77, 16, 'r-1', 8, 'tos', 'Approved', '2026-04-05T06:07:08Z')`,
      [IMAGE]
    );

    expect(
      await rows(
        `SELECT "labellerKind", "labellerRef", "family", "question", "value", "sourceRef", "labelledAt"
         FROM label_store.labels_feed`
      )
    ).toEqual([
      {
        labellerKind: 'appeal',
        labellerRef: 'appeal-review',
        family: 'appeal',
        question: 'image.appeal',
        value: 'approved',
        sourceRef: 'AppealDecisionRecord:900',
        labelledAt: new Date('2026-04-05T06:07:08Z'),
      },
    ]);
    expect(await rows(`SELECT "snapshot", "pHash" FROM label_store.subject`)).toEqual([
      {
        snapshot: {
          url: 'u-501',
          nsfwLevel: 16,
          aiNsfwLevel: 8,
          blockedFor: 'tos',
          nsfwLevelReason: 'r-1',
        },
        pHash: 77,
      },
    ]);
  });

  it('a flag carries its detail, the negative prompt and the pHash', async () => {
    await db.pg.query(
      `UPDATE "Image" SET "meta" = '{"prompt": "a cat", "negativePrompt": "a dog"}' WHERE "id" = $1`,
      [IMAGE]
    );
    await db.pg.query(
      `INSERT INTO "ScanLabelFlag" ("itemId", "source", "flaggerVersion", "reason", "workflowId", "flaggedAt", "snapshot")
       VALUES ($1, 'orchestrator-scan', 'scanner@1', 'hit', 'wf-1', now(), '{"score": 0.9}')`,
      [ITEM]
    );

    expect(await rows(`SELECT "detail" FROM label_store.prediction`)).toEqual([
      { detail: { source: 'orchestrator-scan', reason: 'hit', outputs: { score: 0.9 } } },
    ]);
    expect(await rows(`SELECT "snapshot", "pHash" FROM label_store.subject`)).toEqual([
      { snapshot: { url: 'u-501', prompt: 'a cat', negativePrompt: 'a dog' }, pHash: 77 },
    ]);
  });

  it('a judgement fills a missing owner on an existing subject', async () => {
    await db.pg.query(
      `SELECT label_store.submit_prediction('image', '601', $1, 'image.block', 'block', 'm@1', 'p-1')`,
      [sha256('u-601')]
    );
    await db.pg.exec(`
      INSERT INTO "Image" ("id", "userId", "url") VALUES (601, 12, 'u-601');
      INSERT INTO "ScanLabelItem" ("id", "imageId") VALUES (9, 601);
      INSERT INTO "ScanLabelVote" ("itemId", "userId", "block", "reason") VALUES (9, 21, true, 'r');
    `);

    expect(await rows(`SELECT label_store.erase_owner(12) AS n`)).toEqual([{ n: 1 }]);
  });
});

describe('consensus rules', () => {
  beforeAll(async () => {
    await db.pg.exec(
      `INSERT INTO label_store.rule VALUES ('image.majority', 1, 3, false) ON CONFLICT DO NOTHING`
    );
  });
  const answer = (value: string, ref: string, user: number) =>
    db.pg.query(
      `SELECT label_store.record_label('image', '${IMAGE}', $1, 'test', 'image.majority', $2,
         'moderator', $3, '2026-01-01T00:00:00Z', $4)`,
      [HASH, value, ref, user]
    );
  const majority = async () =>
    (
      await rows(
        `SELECT "outcome", "rule", "trainable", "unanimous" FROM label_store.consensus
         WHERE "question" = 'image.majority'`
      )
    )[0];

  it('a majority rule trains on a split vote and names itself', async () => {
    await answer('block', 'a', MODS[0]);
    await answer('block', 'b', MODS[1]);
    await answer('clear', 'c', MODS[2]);

    expect(await majority()).toEqual({
      outcome: 'block',
      rule: 'min3-majority',
      trainable: true,
      unanimous: false,
    });
  });

  it('two answers from one person at the same moment: the later recorded wins', async () => {
    await answer('block', 'a-1', MODS[0]);
    await answer('clear', 'a-2', MODS[0]);
    await answer('clear', 'b', MODS[1]);
    await answer('clear', 'c', MODS[2]);

    expect(await majority()).toMatchObject({ outcome: 'clear', unanimous: true });
  });

  it('two predictions at the same moment: the later recorded counts', async () => {
    for (const m of MODS.slice(0, 3)) await vote(m, true);
    for (const [ref, value] of [
      ['p-1', 'clear'],
      ['p-2', 'block'],
    ])
      await db.pg.query(
        `SELECT label_store.submit_prediction('image', '${IMAGE}', $1, 'image.block', $2, 'm@1', $3,
           '2026-01-01T00:00:00Z')`,
        [HASH, value, ref]
      );

    expect(await consensus()).toMatchObject({ modelValue: 'block', modelAgrees: true });
  });
});

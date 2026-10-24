import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootLabelStore, LABEL_STORE_MIGRATION } from './label-store.fixture';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The label store migration, executed unmodified on an in-process Postgres with the source tables it
 * hooks into. Cases that expect nothing carry a twin that differs in one property and does produce
 * something, so an empty result cannot come from a store that records nothing.
 */

const db = { pg: null as unknown as PGlite };

const OWNER = 11;
const IMAGE = 501;
const ITEM = 7;
const MODS = [21, 22, 23];
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

beforeAll(async () => {
  db.pg = await PGlite.create();
  await bootLabelStore(db.pg);
  // The scoped roles infra creates, then the migration's grant block re-run as the header says.
  await db.pg.exec(`CREATE ROLE label_reader; CREATE ROLE site_app;`);
  const grant = readFileSync(LABEL_STORE_MIGRATION, 'utf8').match(
    /DO \$\$\r?\nBEGIN\r?\n {2}IF EXISTS[\s\S]*?\r?\n\$\$;/
  );
  if (!grant) throw new Error('grant block not found in the migration');
  await db.pg.exec(grant[0]);
  // A site role that writes the source tables but owns nothing in the store.
  await db.pg.exec(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "ScanLabelVote", "ScanLabelItem", "Image", "ScanLabelFlag",
       "AppealDecisionRecord", "ScanLabelCopyObject" TO site_app;
     GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO site_app;`
  );
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

const vote = (userId: number, block: boolean) =>
  db.pg.query(
    `INSERT INTO "ScanLabelVote" ("itemId", "userId", "block", "reason", "msOnItem")
     VALUES ($1, $2, $3, $4, 1500)`,
    [ITEM, userId, block, block ? 'reason-a' : null]
  );

const flag = (workflowId = 'wf-1', source = 'orchestrator-scan') =>
  db.pg.query(
    `INSERT INTO "ScanLabelFlag" ("itemId", "source", "flaggerVersion", "reason", "workflowId", "flaggedAt", "snapshot")
     VALUES ($1, $2, 'scanner@1', 'hit', $3, '2026-01-01T00:00:00Z', '{"score": 0.9}')`,
    [ITEM, source, workflowId]
  );

const rows = async <T>(sql: string) => (await db.pg.query<T>(sql)).rows;

const asRole = async (role: string, fn: () => Promise<void>) => {
  await db.pg.exec(`SET ROLE ${role}`);
  try {
    await fn();
  } finally {
    await db.pg.exec(`RESET ROLE`);
  }
};

const consensus = async () =>
  (
    await rows<{
      outcome: string | null;
      humanLabels: number;
      agreeing: number;
      unanimous: boolean;
      trainable: boolean;
      modelValue: string | null;
      modelRef: string | null;
      modelAgrees: boolean | null;
    }>(`SELECT * FROM label_store.consensus WHERE "question" = 'image.block'`)
  )[0];

describe('votes', () => {
  it('records each vote as a human label on the image, without the raw user id', async () => {
    await vote(MODS[0], true);

    const labels = await rows<{
      value: string;
      reason: string;
      labellerKind: string;
      labellerRef: string;
      sourceRef: string;
      msOnItem: number;
      siteId: string;
      subjectType: string;
    }>(`SELECT * FROM label_store.labels_feed`);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      subjectType: 'image',
      siteId: String(IMAGE),
      value: 'block',
      reason: 'reason-a',
      labellerKind: 'moderator',
      msOnItem: 1500,
    });
    expect(labels[0].labellerRef).toMatch(/^[0-9a-f]{64}$/);
    expect(labels[0].sourceRef).toBe(`ScanLabelVote:${ITEM}:${labels[0].labellerRef}`);
  });

  it('three agreeing votes make the subject trainable', async () => {
    for (const m of MODS) await vote(m, false);

    expect(await consensus()).toMatchObject({
      outcome: 'clear',
      humanLabels: 3,
      agreeing: 3,
      unanimous: true,
      trainable: true,
    });
    expect(await rows(`SELECT * FROM label_store.training_examples`)).toHaveLength(1);
  });

  it('a split vote has a majority outcome but is not trainable under the unanimous rule', async () => {
    await vote(MODS[0], false);
    await vote(MODS[1], false);
    await vote(MODS[2], true);

    expect(await consensus()).toMatchObject({
      outcome: 'clear',
      humanLabels: 3,
      agreeing: 2,
      unanimous: false,
      trainable: false,
    });
    expect(await rows(`SELECT * FROM label_store.training_examples`)).toHaveLength(0);
  });

  it('two votes are not yet an outcome', async () => {
    await vote(MODS[0], false);
    await vote(MODS[1], false);

    expect(await consensus()).toMatchObject({ outcome: null, humanLabels: 2, trainable: false });
  });

  it('counts a person once, with their latest answer', async () => {
    const relabel = (ref: string, value: string, at: string) =>
      db.pg.query(
        `SELECT label_store.record_label(
           p_subject_type => 'image', p_subject_id => '${IMAGE}', p_content_hash => 'h',
           p_family => 'relabel', p_question => 'image.block', p_value => $1,
           p_labeller_kind => 'moderator', p_labeller_user_id => ${MODS[0]},
           p_source_ref => $2, p_labelled_at => $3::timestamptz)`,
        [value, ref, at]
      );
    await relabel('r-1', 'block', '2026-01-01T00:00:00Z');
    await relabel('r-2', 'clear', '2026-01-02T00:00:00Z');

    expect(await rows(`SELECT * FROM label_store.label`)).toHaveLength(2);
    expect(await consensus()).toMatchObject({ humanLabels: 1, agreeing: 1 });
    expect(
      await rows(
        `SELECT 1 FROM label_store.consensus c JOIN label_store.label l ON l."subjectId" = c."subjectId"
         WHERE l."sourceRef" = 'r-2'`
      )
    ).toHaveLength(1);
  });
});

describe('predictions', () => {
  it('keeps a scanner flag as a prediction, apart from human labels, with its exact input hash', async () => {
    await flag('wf-upload', 'orchestrator-scan');
    await flag('wf-prompt', 'xguard-prompt');

    expect(await rows(`SELECT * FROM label_store.labels_feed`)).toHaveLength(0);
    const preds = await rows<{
      sourceRef: string;
      value: string;
      modelRef: string;
      inputHash: string;
    }>(`SELECT * FROM label_store.predictions_feed ORDER BY "sourceRef"`);
    expect(preds).toEqual([
      expect.objectContaining({
        sourceRef: 'ScanLabelFlag:wf-prompt',
        value: 'block',
        modelRef: 'scanner@1',
        inputHash: sha256('a cat'),
      }),
      expect.objectContaining({
        sourceRef: 'ScanLabelFlag:wf-upload',
        value: 'block',
        modelRef: 'scanner@1',
        inputHash: sha256('u-501'),
      }),
    ]);
  });

  it('a prediction the people overrule is a pipeline failure', async () => {
    await flag();
    for (const m of MODS) await vote(m, false);

    expect(await consensus()).toMatchObject({
      outcome: 'clear',
      modelValue: 'block',
      modelRef: 'scanner@1',
      modelAgrees: false,
    });
    const failures = await rows<{ siteId: string }>(`SELECT * FROM label_store.pipeline_failures`);
    expect(failures.map((f) => f.siteId)).toEqual([String(IMAGE)]);
  });

  it('a prediction the people confirm is not a failure', async () => {
    await flag();
    for (const m of MODS) await vote(m, true);

    expect(await consensus()).toMatchObject({
      outcome: 'block',
      modelAgrees: true,
      trainable: true,
    });
    expect(await rows(`SELECT * FROM label_store.pipeline_failures`)).toHaveLength(0);
  });

  it('a control-sample flag records nothing, where a scanner flag does', async () => {
    await flag('wf-control', 'control-sample');
    expect(await rows(`SELECT * FROM label_store.prediction`)).toHaveLength(0);

    await flag('wf-scan', 'orchestrator-scan');
    expect(await rows(`SELECT * FROM label_store.prediction`)).toHaveLength(1);
  });
});

describe('submit_prediction (the pipeline endpoint)', () => {
  const submit = (value: string | null) =>
    db.pg.query<{ id: number }>(
      `SELECT label_store.submit_prediction(
         p_subject_type => 'image', p_subject_id => '${IMAGE}', p_content_hash => 'h-501',
         p_question => 'image.rating', p_value => $1, p_model_ref => 'rater@3', p_source_ref => 'run-1:${IMAGE}',
         p_confidence => 0.8, p_scores => '{"a": 0.1, "b": 0.8}', p_versions => '{"v": 2}',
         p_input_hash => 'in-1') AS id`,
      [value]
    );

  it('records a prediction with its scores and versions, owned by the image owner', async () => {
    expect((await submit('b')).rows[0].id).toBeGreaterThan(0);

    const [p] = await rows<{
      family: string;
      sourceRef: string;
      scores: unknown;
      versions: unknown;
      inputHash: string;
    }>(`SELECT * FROM label_store.predictions_feed`);
    expect(p).toMatchObject({
      family: 'pipeline',
      sourceRef: `pipeline:run-1:${IMAGE}`,
      scores: { a: 0.1, b: 0.8 },
      versions: { v: 2 },
      inputHash: 'in-1',
    });
    const [{ n }] = await rows<{ n: number }>(`SELECT label_store.erase_owner(${OWNER}) AS n`);
    expect(n).toBe(1);
  });

  it('refuses an incomplete prediction, loudly', async () => {
    await expect(submit(null)).rejects.toThrow(/required/);
    expect(await rows(`SELECT * FROM label_store.prediction`)).toHaveLength(0);
  });

  it('cannot take a sourceRef the site writes', async () => {
    await db.pg.query(
      `SELECT label_store.submit_prediction('image', '${IMAGE}', 'h', 'image.block', 'block', 'm@1', 'ScanLabelFlag:wf-1')`
    );
    await flag('wf-1');

    expect(
      await rows(`SELECT "sourceRef" FROM label_store.prediction ORDER BY "sourceRef"`)
    ).toEqual([{ sourceRef: 'ScanLabelFlag:wf-1' }, { sourceRef: 'pipeline:ScanLabelFlag:wf-1' }]);
  });
});

describe('the reader role', () => {
  it('reads the views and nothing else, and cannot hash user ids or write', async () => {
    await vote(MODS[0], false);

    await asRole('label_reader', async () => {
      expect(await rows(`SELECT * FROM label_store.labels_feed`)).toHaveLength(1);
      expect(await rows(`SELECT * FROM label_store.changes_feed`)).not.toHaveLength(0);
      await expect(db.pg.query(`SELECT * FROM label_store.label`)).rejects.toThrow(
        /permission denied/
      );
      await expect(db.pg.query(`SELECT * FROM label_store.secret`)).rejects.toThrow(
        /permission denied/
      );
      await expect(db.pg.query(`SELECT label_store.person_hash('labeller', 21)`)).rejects.toThrow(
        /permission denied/
      );
      await expect(
        db.pg.query(
          `SELECT label_store.submit_prediction('image', '1', 'h', 'image.block', 'block', 'm@1', 's')`
        )
      ).rejects.toThrow(/permission denied/);
    });
  });
});

describe('the change feed', () => {
  it('carries labels, consensus updates, exclusions and deletions in order', async () => {
    for (const m of MODS) await vote(m, false);
    await db.pg.query(`SELECT label_store.exclude('image', '${IMAGE}', 'removed')`);
    const [{ id: subjectId }] = await rows<{ id: number }>(`SELECT "id" FROM label_store.subject`);
    await db.pg.query(`SELECT label_store.erase_owner(${OWNER})`);

    const feed = await rows<{ kind: string; subjectId: number }>(
      `SELECT "kind", "subjectId" FROM label_store.changes_feed ORDER BY "id"`
    );
    expect(feed.map((c) => c.kind)).toEqual([
      'label',
      'consensus',
      'label',
      'consensus',
      'label',
      'consensus',
      'exclusion',
      'deletion',
    ]);
    expect(new Set(feed.map((c) => Number(c.subjectId)))).toEqual(new Set([Number(subjectId)]));
    expect(await rows(`SELECT * FROM label_store.subject`)).toHaveLength(0);
  });

  it('a label that changes no consensus value adds no consensus change', async () => {
    for (const m of MODS) await vote(m, false);
    const before = await rows(`SELECT * FROM label_store.change WHERE "kind" = 'consensus'`);
    // The same person giving the same answer again: a new label, the same consensus.
    await db.pg.query(
      `SELECT label_store.record_label('image', '${IMAGE}', '${sha256(
        'u-501'
      )}', 'relabel', 'image.block',
         'clear', 'moderator', 'again-1', now(), ${MODS[0]})`
    );

    expect(await rows(`SELECT * FROM label_store.change WHERE "kind" = 'label'`)).toHaveLength(4);
    expect(await rows(`SELECT * FROM label_store.change WHERE "kind" = 'consensus'`)).toEqual(
      before
    );
  });

  it('excluding twice is one exclusion', async () => {
    await vote(MODS[0], false);
    await db.pg.query(`SELECT label_store.exclude('image', '${IMAGE}', 'removed')`);
    await db.pg.query(`SELECT label_store.exclude('image', '${IMAGE}', 'removed')`);

    expect(await rows(`SELECT * FROM label_store.change WHERE "kind" = 'exclusion'`)).toHaveLength(
      1
    );
  });
});

describe('durability', () => {
  it('labels and their consensus outlive the image', async () => {
    for (const m of MODS) await vote(m, false);
    await db.pg.query(`DELETE FROM "Image" WHERE "id" = $1`, [IMAGE]);

    expect(await rows(`SELECT * FROM "ScanLabelVote"`)).toHaveLength(0);
    expect(await rows(`SELECT * FROM label_store.label`)).toHaveLength(3);
    expect(await rows(`SELECT * FROM label_store.training_examples`)).toHaveLength(1);
  });

  it('an appeal decision is recorded from the record alone, after its image is gone', async () => {
    await db.pg.query(`DELETE FROM "Image" WHERE "id" = $1`, [IMAGE]);
    await db.pg.query(
      `INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "imageUrl", "pHash", "nsfwLevel", "decision", "decidedAt")
       VALUES (900, $1, 'u-501', 77, 16, 'Rejected', '2026-01-02T00:00:00Z')`,
      [IMAGE]
    );

    expect(await rows(`SELECT * FROM label_store.labels_feed`)).toEqual([
      expect.objectContaining({ question: 'image.appeal', value: 'rejected', family: 'appeal' }),
    ]);
  });
});

describe('a site write never fails because of the store', () => {
  it('logs a failed label to record_failure and keeps the vote', async () => {
    await db.pg.exec(
      `ALTER TABLE label_store.label ADD CONSTRAINT forced_failure CHECK ("value" <> 'clear')`
    );
    try {
      await vote(MODS[0], false);

      expect(await rows(`SELECT * FROM "ScanLabelVote"`)).toHaveLength(1);
      expect(await rows(`SELECT * FROM label_store.label`)).toHaveLength(0);
      const failures = await rows<{ sourceRef: string; error: string }>(
        `SELECT * FROM label_store.record_failure`
      );
      expect(failures).toHaveLength(1);
      expect(failures[0].sourceRef).toMatch(/^ScanLabelVote:7:/);
      expect(failures[0].error).toContain('forced_failure');
    } finally {
      await db.pg.exec(`ALTER TABLE label_store.label DROP CONSTRAINT forced_failure`);
    }
  });

  it('logs a vote whose image cannot be found', async () => {
    await db.pg.exec(`ALTER TABLE "ScanLabelItem" DROP CONSTRAINT "ScanLabelItem_imageId_fkey"`);
    try {
      await db.pg.query(`UPDATE "ScanLabelItem" SET "imageId" = 999 WHERE "id" = $1`, [ITEM]);
      await vote(MODS[0], false);

      expect(await rows(`SELECT * FROM "ScanLabelVote"`)).toHaveLength(1);
      expect(await rows(`SELECT "error" FROM label_store.record_failure`)).toEqual([
        { error: 'image not found' },
      ]);
    } finally {
      await db.pg.query(`UPDATE "ScanLabelItem" SET "imageId" = $1 WHERE "id" = $2`, [IMAGE, ITEM]);
      await db.pg.exec(
        `ALTER TABLE "ScanLabelItem" ADD CONSTRAINT "ScanLabelItem_imageId_fkey"
         FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE CASCADE`
      );
    }
  });

  const copy = () =>
    db.pg.query(
      `UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = 'k/1', "copiedAt" = now()`
    );
  const appeal = () =>
    db.pg.query(
      `INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "imageUrl", "nsfwLevel", "decision", "decidedAt")
       VALUES (900, $1, 'u-501', 16, 'Approved', now())`,
      [IMAGE]
    );
  const subject = async () =>
    (
      await rows<{ bytesRef: string | null; excludedReason: string | null }>(
        `SELECT "bytesRef", "excludedReason" FROM label_store.subject`
      )
    )[0];
  // Each write a site role makes, run as a role that owns nothing in the store.
  const SITE_WRITES: {
    name: string;
    before?: () => Promise<unknown>;
    write: () => Promise<unknown>;
    check: () => Promise<void>;
  }[] = [
    {
      name: 'a flag',
      write: () => flag(),
      check: async () => expect(await rows(`SELECT * FROM label_store.prediction`)).toHaveLength(1),
    },
    {
      name: 'a vote',
      write: () => vote(MODS[0], false),
      check: async () => expect(await rows(`SELECT * FROM label_store.label`)).toHaveLength(1),
    },
    {
      name: 'an appeal decision',
      write: appeal,
      check: async () => expect(await rows(`SELECT * FROM label_store.label`)).toHaveLength(1),
    },
    {
      name: 'a copy',
      before: () => vote(MODS[0], false),
      write: copy,
      check: async () => expect(await subject()).toMatchObject({ bytesRef: 'scan-label-copy:k/1' }),
    },
    {
      name: 'a withdrawal',
      before: async () => {
        await vote(MODS[0], false);
        await copy();
        await db.pg.query(
          `INSERT INTO "ScanLabelCopyObject" ("key", "itemId", "imageId") VALUES ('k/1', $1, $2)`,
          [ITEM, IMAGE]
        );
      },
      write: () =>
        db.pg.query(
          `UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now(), "withdrawReason" = 'excluded'`
        ),
      check: async () =>
        expect(await subject()).toMatchObject({ bytesRef: null, excludedReason: 'safety' }),
    },
    {
      name: 'an appeal record deletion',
      before: appeal,
      write: () => db.pg.query(`DELETE FROM "AppealDecisionRecord"`),
      check: async () => expect(await subject()).toMatchObject({ excludedReason: 'removed' }),
    },
  ];

  it.each(SITE_WRITES)(
    'records $name made by a site role that owns nothing in the store',
    async ({ before, write, check }) => {
      await before?.();
      await asRole('site_app', async () => {
        await write();
      });

      await check();
      expect(await rows(`SELECT * FROM label_store.record_failure`)).toEqual([]);
    }
  );
});

describe('bytes and exclusion', () => {
  const copy = () =>
    db.pg.query(
      `UPDATE "ScanLabelItem" SET "copyState" = 'copied', "copyKey" = 'k/u-501', "copiedAt" = now() WHERE "id" = $1`,
      [ITEM]
    );
  const withdraw = async (reason: string) => {
    await db.pg.query(
      `INSERT INTO "ScanLabelCopyObject" ("key", "itemId", "imageId") VALUES ('k/u-501', $1, $2)`,
      [ITEM, IMAGE]
    );
    await db.pg.query(
      `UPDATE "ScanLabelCopyObject" SET "withdrawnAt" = now(), "withdrawReason" = $1`,
      [reason]
    );
  };

  it('a copy becomes the subject bytes, and an excluded withdrawal takes the subject out of training', async () => {
    for (const m of MODS) await vote(m, false);
    await copy();
    expect(await rows(`SELECT "bytesRef" FROM label_store.training_examples`)).toEqual([
      { bytesRef: 'scan-label-copy:k/u-501' },
    ]);

    await withdraw('excluded');

    expect(await rows(`SELECT * FROM label_store.training_examples`)).toHaveLength(0);
    expect(await rows(`SELECT * FROM label_store.subject`)).toEqual([
      expect.objectContaining({ excludedReason: 'safety', snapshot: null, bytesRef: null }),
    ]);
    expect(await rows(`SELECT * FROM label_store.label`)).toHaveLength(3);
  });

  it('a withdrawal for any other reason drops the bytes but keeps the subject trainable', async () => {
    for (const m of MODS) await vote(m, false);
    await copy();
    await withdraw('gone');

    expect(await rows(`SELECT "bytesRef" FROM label_store.training_examples`)).toEqual([
      { bytesRef: null },
    ]);
  });

  it('erasing an owner deletes their subjects and labels, and leaves other owners alone', async () => {
    await vote(MODS[0], false);
    await db.pg.exec(
      `INSERT INTO "Image" ("id", "userId", "url") VALUES (502, 12, 'u-502');
       INSERT INTO "ScanLabelItem" ("id", "imageId") VALUES (8, 502);`
    );
    await db.pg.query(
      `INSERT INTO "ScanLabelVote" ("itemId", "userId", "block") VALUES (8, $1, false)`,
      [MODS[0]]
    );

    const [{ n }] = await rows<{ n: number }>(`SELECT label_store.erase_owner(${OWNER}) AS n`);
    expect(n).toBe(1);
    expect(await rows(`SELECT "siteId" FROM label_store.labels_feed`)).toEqual([{ siteId: '502' }]);
  });
});

describe('backfill', () => {
  it('rebuilds the judgements of rows that predate the store, and a re-run adds nothing', async () => {
    await flag();
    for (const m of MODS) await vote(m, false);
    const labels = `SELECT "sourceRef", "value" FROM label_store.label ORDER BY "sourceRef"`;
    const preds = `SELECT "sourceRef", "value", "inputHash" FROM label_store.prediction ORDER BY "sourceRef"`;
    const before = [await rows(labels), await rows(preds)];
    expect(before.map((r) => r.length)).toEqual([3, 1]);
    await db.pg.exec(`TRUNCATE label_store.subject, label_store.change RESTART IDENTITY CASCADE`);

    const first = await rows<{ source: string; rows: number; added: number }>(
      `SELECT * FROM label_store.backfill()`
    );
    expect(first).toEqual(
      expect.arrayContaining([
        { source: 'ScanLabelFlag', rows: 1, added: 1 },
        { source: 'ScanLabelVote', rows: 3, added: 3 },
      ])
    );
    expect([await rows(labels), await rows(preds)]).toEqual(before);
    expect(await consensus()).toMatchObject({
      outcome: 'clear',
      modelAgrees: false,
      trainable: true,
    });

    const second = await rows<{ added: number }>(`SELECT * FROM label_store.backfill()`);
    expect(second.map((r) => r.added)).toEqual([0, 0, 0]);
    expect(await rows(`SELECT * FROM label_store.record_failure`)).toHaveLength(0);
  });
});

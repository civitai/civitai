import { describe, expect, it, vi } from 'vitest';
import { migration } from '~/server/services/__tests__/comment-v3-fixture';
import { commentSchemaDatabase } from '~/server/services/feature-pages/__tests__/fp-harness';

// The apply order the migration's header gives: dry-run step 1, apply it, dry-run steps 2 and 3 in
// one transaction (step 2's own BEGIN and COMMIT removed), apply them.
vi.setConfig({ testTimeout: 120_000 });

const sql = migration('20271125140000_feature_page_comments');
const [step1, rest] = sql.split('\n-- 2.');
const steps23 = `-- 2.${rest}`;
const steps23InOne = steps23.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');

describe('the feature page comments migration, applied as its header says', () => {
  it('leaves nothing after each dry run, adds everything when applied, and re-runs cleanly', async () => {
    const db = await commentSchemaDatabase();
    const label = async () =>
      (
        await db.query(
          `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
           WHERE t.typname = 'CommentEntityType' AND e.enumlabel = 'featurePage'`
        )
      ).rows.length === 1;
    const tables = async () =>
      (
        await db.query<{ relname: string }>(
          `SELECT relname FROM pg_class WHERE relkind IN ('r', 'p') AND relname = ANY($1) ORDER BY relname`,
          [['CommentTopic_featurePage', 'FeaturePageCommentMirror', 'FeaturePageTopic']]
        )
      ).rows.map((r) => r.relname);
    expect(steps23InOne).not.toMatch(/^(BEGIN|COMMIT);$/m);

    await db.exec(`BEGIN;\n${step1}\nROLLBACK;`);
    expect(await label()).toBe(false);
    await db.exec(step1);
    expect(await label()).toBe(true);

    await db.exec('BEGIN;');
    await db.exec(steps23InOne);
    const locks = await db.query<{ relname: string; mode: string }>(
      `SELECT c.relname, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
       WHERE c.relname IN ('CommentTopic', 'CommentV3') ORDER BY 1, 2`
    );
    // The header's lock note: comment reads and writes wait while step 2 runs.
    expect(locks.rows).toEqual(
      expect.arrayContaining([
        { relname: 'CommentTopic', mode: 'AccessExclusiveLock' },
        { relname: 'CommentV3', mode: 'ShareRowExclusiveLock' },
      ])
    );
    await db.exec('ROLLBACK;');
    expect(await tables()).toEqual([]);

    await db.exec(steps23);
    expect(await tables()).toEqual([
      'CommentTopic_featurePage',
      'FeaturePageCommentMirror',
      'FeaturePageTopic',
    ]);

    await db.exec(step1);
    await db.exec(steps23);
    expect(await label()).toBe(true);
    expect(await tables()).toHaveLength(3);
    await db.close();
  });
});

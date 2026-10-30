import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE, migration } from './comment-v3-fixture';

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

// A comment is queued for moderation once: as CommentV3 when written there directly, and as the old
// table's type when the mirror copies it into CommentV3.

// The moderation queue and trigger function as 20250521094141_add_clavata_moderation left them, cut
// down to what these comments use.
const MODERATION_QUEUE = `
CREATE TYPE "EntityType" AS ENUM ('Comment', 'CommentV2');
CREATE TYPE "JobQueueType" AS ENUM ('ModerationRequest');
CREATE TABLE "JobQueue"(
  type "JobQueueType" NOT NULL, "entityType" "EntityType" NOT NULL, "entityId" int NOT NULL,
  PRIMARY KEY (type, "entityType", "entityId")
);
CREATE FUNCTION create_job_queue_moderation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "JobQueue" (type, "entityType", "entityId")
  VALUES ('ModerationRequest', TG_ARGV[0]::"EntityType", NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_moderation_commentv2 AFTER UPDATE OF "content" OR INSERT ON "CommentV2"
  FOR EACH ROW EXECUTE FUNCTION create_job_queue_moderation('CommentV2');
`;

const db = { pg: null as unknown as PGlite };
const queued = async () =>
  (
    await db.pg.query<{ entityType: string; entityId: number }>(
      `SELECT "entityType"::text AS "entityType", "entityId" FROM "JobQueue" ORDER BY 1, 2`
    )
  ).rows;

beforeAll(async () => {
  db.pg = new PGlite({ extensions: { ltree } });
  await db.pg.exec(FIXTURE);
  await db.pg.exec(MODERATION_QUEUE);
  await db.pg.exec(migration('20261110120000_comment_v3_schema'));
  await db.pg.exec(migration('20261120120000_comment_v3_mirror'));
  await db.pg.exec(migration('20261210120000_comment_v3_mirror_changed_columns'));
  await db.pg.exec(migration('20261211120000_comment_v3_moderation_trigger'));
  await db.pg.exec(`
    SELECT setval('comment_shared_id_seq', 10000, true);
    INSERT INTO "User" VALUES (1) ON CONFLICT DO NOTHING;
    INSERT INTO "Image" VALUES (10) ON CONFLICT DO NOTHING;
    INSERT INTO "Article" VALUES (5) ON CONFLICT DO NOTHING;
    INSERT INTO "Thread"(id, "imageId") VALUES (1, 10);
    INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('article', 5);
  `);
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`DELETE FROM "JobQueue"`);
});

describe('the CommentV3 moderation trigger', () => {
  it('queues a comment written to CommentV3, and again when its content is edited', async () => {
    const {
      rows: [{ id }],
    } = await db.pg.query<{ id: number }>(
      `INSERT INTO "CommentV3"("entityType", "entityId", "userId", content)
       VALUES ('article', 5, 1, 'new') RETURNING id`
    );
    expect(await queued()).toEqual([{ entityType: 'CommentV3', entityId: id }]);

    await db.pg.exec(`DELETE FROM "JobQueue"`);
    await db.pg.exec(`UPDATE "CommentV3" SET content = 'edited' WHERE id = ${id}`);
    expect(await queued()).toEqual([{ entityType: 'CommentV3', entityId: id }]);

    // A hide, pin or ToS flag leaves the content alone and is not rescanned.
    await db.pg.exec(`DELETE FROM "JobQueue"`);
    await db.pg.exec(
      `UPDATE "CommentV3" SET hidden = true, "tosViolation" = true WHERE id = ${id}`
    );
    expect(await queued()).toEqual([]);
  });

  it('leaves a comment the mirror copies to the old table’s own trigger', async () => {
    const {
      rows: [{ id }],
    } = await db.pg.query<{ id: number }>(
      `INSERT INTO "CommentV2"(content, "userId", "threadId") VALUES ('old', 1, 1) RETURNING id`
    );
    await db.pg.exec(`UPDATE "CommentV2" SET content = 'old, edited' WHERE id = ${id}`);

    const { rows } = await db.pg.query<{ content: string }>(
      `SELECT content FROM "CommentV3" WHERE id = ${id}`
    );
    expect(rows).toEqual([{ content: 'old, edited' }]);
    expect(await queued()).toEqual([{ entityType: 'CommentV2', entityId: id }]);
  });
});

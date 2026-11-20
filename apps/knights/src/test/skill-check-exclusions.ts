import type { PGlite } from '@electric-sql/pglite';

/**
 * One way to put an image under each skill-check exclusion (`SKILL_CHECK_EXCLUSIONS`), keyed by the clause's name, for
 * the insert and serve tests (`pg` is read when a case runs, after the database boots). Each sets up the state for image `id` (seeded by `seedImage`, whose post id is the image id).
 */
export const exclusionCases = (pg: () => PGlite): [string, (id: number) => Promise<unknown>][] => [
  ['tos-violation', (id) => pg().query(`UPDATE "Image" SET "tosViolation"=true WHERE id=$1`, [id])],
  [
    'legal-hold',
    async (id) => {
      await pg().query(`UPDATE "Image" SET "userId"=40 WHERE id=$1`, [id]);
      await pg().query(`INSERT INTO "EvidenceHeldUser" ("userId") VALUES (40)`);
    },
  ],
  [
    'suspect-image',
    (id) =>
      pg().query(`INSERT INTO "ScanLabelItem" ("imageId","voidReason") VALUES ($1,'csam-hold')`, [
        id,
      ]),
  ],
  [
    'unreadable-image',
    (id) => pg().query(`UPDATE "Image" SET ingestion='Pending' WHERE id=$1`, [id]),
  ],
  [
    'reported-image',
    (id) =>
      pg().query(
        `INSERT INTO "CsamReport" ("userId","images") VALUES (41, jsonb_build_array(jsonb_build_object('id',$1::int)))`,
        [id]
      ),
  ],
  [
    'evidence-hold-image',
    (id) => pg().query(`INSERT INTO "EvidenceHoldImage" ("imageId","userId") VALUES ($1,1)`, [id]),
  ],
  [
    'evidence-hold-post',
    (id) => pg().query(`INSERT INTO "EvidenceHoldPost" ("postId","userId") VALUES ($1,1)`, [id]),
  ],
  [
    'open-report',
    async (id) => {
      await pg().query(`INSERT INTO "Report" ("id","status") VALUES (50,'Pending')`);
      await pg().query(`INSERT INTO "ImageReport" ("reportId","imageId") VALUES (50,$1)`, [id]);
    },
  ],
  [
    'open-post-report',
    async (id) => {
      await pg().query(`INSERT INTO "Report" ("id","status") VALUES (51,'Processing')`);
      await pg().query(`INSERT INTO "PostReport" ("reportId","postId") VALUES (51,$1)`, [id]);
    },
  ],
  [
    'open-model-report',
    async (id) => {
      await pg().query(`INSERT INTO "Model" ("id") VALUES (80)`);
      await pg().query(`INSERT INTO "ModelVersion" ("id","modelId") VALUES (81,80)`);
      await pg().query(
        `INSERT INTO "ImageResourceNew" ("imageId","modelVersionId") VALUES ($1,81)`,
        [id]
      );
      await pg().query(`INSERT INTO "Report" ("id","status") VALUES (52,'Pending')`);
      await pg().query(`INSERT INTO "ModelReport" ("reportId","modelId") VALUES (52,80)`);
    },
  ],
  [
    'open-user-report',
    async (id) => {
      await pg().query(`UPDATE "Image" SET "userId"=45 WHERE id=$1`, [id]);
      await pg().query(`INSERT INTO "Report" ("id","status") VALUES (53,'Pending')`);
      await pg().query(`INSERT INTO "UserReport" ("reportId","userId") VALUES (53,45)`);
    },
  ],
  [
    'prompt-flag',
    (id) => pg().query(`INSERT INTO "ImageFlag" ("imageId","promptNsfw") VALUES ($1,true)`, [id]),
  ],
  [
    'pending-appeal',
    (id) =>
      pg().query(
        `INSERT INTO "Appeal" ("entityType","entityId","status") VALUES ('Image',$1,'Pending')`,
        [id]
      ),
  ],
  [
    'text-scan-hold',
    (id) =>
      pg().query(
        `INSERT INTO "TextScanHold" ("entityType","entityId","status") VALUES ('Post',$1,'Pending')`,
        [id]
      ),
  ],
  [
    'uploader-banned-or-muted',
    async (id) => {
      await pg().query(`INSERT INTO "User" ("id","username","muted") VALUES (42,'m',true)`);
      await pg().query(`UPDATE "Image" SET "userId"=42 WHERE id=$1`, [id]);
    },
  ],
  [
    'minor-or-poi-model',
    async (id) => {
      await pg().query(`INSERT INTO "Model" ("id","minor") VALUES (60,true)`);
      await pg().query(`INSERT INTO "ModelVersion" ("id","modelId") VALUES (61,60)`);
      await pg().query(
        `INSERT INTO "ImageResourceNew" ("imageId","modelVersionId") VALUES ($1,61)`,
        [id]
      );
    },
  ],
  [
    'open-inquisitor-item',
    (id) =>
      pg().query(
        `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded","status") VALUES ('knights.image.nsfwLevel',$1,'test','Inquisitor',1,'Inquisitor')`,
        [id]
      ),
  ],
];

/** Extra cases for clauses with more than one leg worth pinning. */
export const extraExclusionCases = (
  pg: () => PGlite
): [string, (id: number) => Promise<unknown>][] => [
  [
    'legal-hold, image leg (flagged for CSAM review)',
    (id) => pg().query(`UPDATE "Image" SET "needsReview"='csam' WHERE id=$1`, [id]),
  ],
  [
    'minor-or-poi-model, poi leg',
    async (id) => {
      await pg().query(`INSERT INTO "Model" ("id","poi") VALUES (62,true)`);
      await pg().query(`INSERT INTO "ModelVersion" ("id","modelId") VALUES (63,62)`);
      await pg().query(
        `INSERT INTO "ImageResourceNew" ("imageId","modelVersionId") VALUES ($1,63)`,
        [id]
      );
    },
  ],
];

/** Every table the exclusion cases write, for a test's TRUNCATE. */
export const EXCLUSION_TABLES =
  '"EvidenceHoldImage","EvidenceHoldPost","ImageReport","PostReport","ModelReport","UserReport","Report","ImageFlag","Appeal","TextScanHold","CsamReport","EvidenceHeldUser","ImageCdnModeratorDelete","ImageResourceNew","ModelVersion","Model","User","ScanLabelItem","TagsOnImageDetails","BlockedImage"';

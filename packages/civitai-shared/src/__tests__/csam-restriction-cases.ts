/**
 * Cases for `csamRestrictedSql` that every suite reading it runs against its own route: rows that
 * share the target's url, and the post-text and article holds. Each `mark` is plain SQL for a
 * PGlite whose schema includes `CSAM_LINK_TABLES_SQL`; `CSAM_CASE_CLEANUP_SQL` removes what any
 * case wrote and clears the target's post.
 */

/** The tables these cases write that the older suite schemas lack. */
export const CSAM_LINK_TABLES_SQL = `
CREATE TABLE "PostText" (id INTEGER PRIMARY KEY, "postId" INTEGER NOT NULL, "csamHeld" BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE "Article" (id INTEGER PRIMARY KEY, "coverId" INTEGER, "bannerId" INTEGER);
CREATE TABLE "ImageConnection" ("imageId" INTEGER NOT NULL, "entityId" INTEGER NOT NULL, "entityType" TEXT NOT NULL);
`;

const SIBLING = 990900001;
const SIBLING_OWNER = 990910001;
const POST = 990920001;
const VERSION = 990930001;
const MODEL = 990940001;
const TEXT = 990950001;
const ARTICLE = 990960001;
const ITEM = 990970001;
const HASH = 990980001;

type Target = { id: number; url: string };
export type CsamCase = { label: string; restricts: boolean; mark: (target: Target) => string };

const sibling = (t: Target, columns: Record<string, string | number> = {}) => {
  const row: Record<string, string | number> = {
    id: SIBLING,
    url: `'${t.url}'`,
    userId: SIBLING_OWNER,
    ingestion: "'Scanned'",
    ...columns,
  };
  return `INSERT INTO "Image" (${Object.keys(row)
    .map((c) => `"${c}"`)
    .join(', ')})
    VALUES (${Object.values(row).join(', ')});`;
};
const hold = (entityType: string, entityId: number, status: string, label = 'csam') =>
  `INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES ('${entityType}', ${entityId}, '${label}', '${status}');`;
const post = `INSERT INTO "Post" (id, metadata, "modelVersionId") VALUES (${POST}, '{}', NULL);`;
const ownPost = (t: Target) => `${post} UPDATE "Image" SET "postId" = ${POST} WHERE id = ${t.id};`;
const postText = (csamHeld = false) =>
  `INSERT INTO "PostText" (id, "postId", "csamHeld") VALUES (${TEXT}, ${POST}, ${csamHeld});`;
const item = (imageId: number) =>
  `INSERT INTO "ScanLabelItem" (id, "imageId", "voidReason") VALUES (${ITEM}, ${imageId}, NULL);`;
const ban = (reasonCode: string) =>
  `INSERT INTO "User" (id, meta) VALUES (${SIBLING_OWNER}, '{"banDetails": {"reasonCode": "${reasonCode}"}}');`;

export const CSAM_RESTRICTION_CASES: CsamCase[] = [
  // Rows sharing the target's url.
  {
    label: 'a row on its url blocked as CSAM',
    restricts: true,
    mark: (t) => sibling(t, { ingestion: "'Blocked'", blockedFor: "'CSAM'" }),
  },
  {
    label: 'a row on its url with a CSAM hash',
    restricts: true,
    mark: (t) =>
      `${sibling(t, {
        pHash: HASH,
      })} INSERT INTO "BlockedImage" (hash, reason) VALUES (${HASH}, 'CSAM');`,
  },
  {
    label: 'a row on its url whose label item is on a csam hold',
    restricts: true,
    mark: (t) =>
      `${sibling(
        t
      )} INSERT INTO "ScanLabelItem" (id, "imageId", "voidReason") VALUES (${ITEM}, ${SIBLING}, 'csam-hold');`,
  },
  {
    label: 'a row on its url with a csam scan flag',
    restricts: true,
    mark: (t) =>
      `${sibling(t)} ${item(
        SIBLING
      )} INSERT INTO "ScanLabelFlag" ("itemId", snapshot) VALUES (${ITEM}, '{"csam": "true"}');`,
  },
  {
    label: 'a row on its url with a csam vote',
    restricts: true,
    mark: (t) =>
      `${sibling(t)} ${item(
        SIBLING
      )} INSERT INTO "ScanLabelVote" ("itemId", reason) VALUES (${ITEM}, 'csam-realistic');`,
  },
  {
    label: 'a row on its url whose owner is banned for minor safety',
    restricts: true,
    mark: (t) => `${sibling(t)} ${ban('SexualMinor')}`,
  },
  {
    label: 'a row on its url whose post is on an undecided csam hold',
    restricts: true,
    mark: (t) => `${post} ${sibling(t, { postId: POST })} ${hold('Post', POST, 'Pending')}`,
  },
  {
    label: 'a row on its url whose model is on a confirmed csam hold',
    restricts: true,
    mark: (t) => `
      INSERT INTO "ModelVersion" (id, meta, "modelId") VALUES (${VERSION}, '{}', ${MODEL});
      INSERT INTO "Post" (id, metadata, "modelVersionId") VALUES (${POST}, '{}', ${VERSION});
      ${sibling(t, { postId: POST })} ${hold('Model', MODEL, 'Confirmed')}`,
  },
  {
    label: "a row on its url whose post's text is on a csam hold",
    restricts: true,
    mark: (t) =>
      `${post} ${postText()} ${sibling(t, { postId: POST })} ${hold('PostText', TEXT, 'Pending')}`,
  },
  {
    label: 'a row on its url that is the cover of an article on a csam hold',
    restricts: true,
    mark: (t) => `${sibling(t)}
      INSERT INTO "Article" (id, "coverId") VALUES (${ARTICLE}, ${SIBLING}); ${hold(
      'Article',
      ARTICLE,
      'Confirmed'
    )}`,
  },
  {
    label: 'a row on its url whose post hold is dismissed',
    restricts: false,
    mark: (t) => `${post} ${sibling(t, { postId: POST })} ${hold('Post', POST, 'Dismissed')}`,
  },
  {
    label: "a row on its url whose post's text hold is dismissed",
    restricts: false,
    mark: (t) =>
      `${post} ${postText()} ${sibling(t, { postId: POST })} ${hold(
        'PostText',
        TEXT,
        'Dismissed'
      )}`,
  },
  {
    label: 'a row on its url with only minor flags',
    restricts: false,
    mark: (t) => sibling(t, { minor: 'true', needsReview: "'minor'" }),
  },
  {
    label: 'a row on its url with only a minor vote',
    restricts: false,
    mark: (t) =>
      `${sibling(t)} ${item(
        SIBLING
      )} INSERT INTO "ScanLabelVote" ("itemId", reason) VALUES (${ITEM}, 'minor-other');`,
  },
  {
    label: 'a row on its url whose owner is banned for another reason',
    restricts: false,
    mark: (t) => `${sibling(t)} ${ban('Other')}`,
  },
  // The image's own post text and articles.
  {
    label: "its post's text on a confirmed csam hold",
    restricts: true,
    mark: (t) => `${ownPost(t)} ${postText()} ${hold('PostText', TEXT, 'Confirmed')}`,
  },
  {
    label: "its post's text held for CSAM",
    restricts: true,
    mark: (t) => `${ownPost(t)} ${postText(true)}`,
  },
  {
    label: 'the cover of an article on an undecided csam hold',
    restricts: true,
    mark: (t) =>
      `INSERT INTO "Article" (id, "coverId") VALUES (${ARTICLE}, ${t.id}); ${hold(
        'Article',
        ARTICLE,
        'Pending'
      )}`,
  },
  {
    label: 'the banner of an article on a csam hold',
    restricts: true,
    mark: (t) =>
      `INSERT INTO "Article" (id, "bannerId") VALUES (${ARTICLE}, ${t.id}); ${hold(
        'Article',
        ARTICLE,
        'Confirmed'
      )}`,
  },
  {
    label: 'an image in an article on a csam hold',
    restricts: true,
    mark: (t) => `
      INSERT INTO "Article" (id) VALUES (${ARTICLE});
      INSERT INTO "ImageConnection" ("imageId", "entityId", "entityType") VALUES (${
        t.id
      }, ${ARTICLE}, 'Article');
      ${hold('Article', ARTICLE, 'Pending')}`,
  },
  {
    label: "its post's text on a dismissed csam hold",
    restricts: false,
    mark: (t) => `${ownPost(t)} ${postText()} ${hold('PostText', TEXT, 'Dismissed')}`,
  },
  {
    label: "its post's text on a hold for another label",
    restricts: false,
    mark: (t) => `${ownPost(t)} ${postText()} ${hold('PostText', TEXT, 'Confirmed', 'other')}`,
  },
  {
    label: "another post's text on a csam hold",
    restricts: false,
    mark: (t) =>
      `${ownPost(t)} INSERT INTO "PostText" (id, "postId") VALUES (${TEXT}, ${POST + 1}); ${hold(
        'PostText',
        TEXT,
        'Confirmed'
      )}`,
  },
  {
    label: 'the cover of an article whose csam hold is dismissed',
    restricts: false,
    mark: (t) =>
      `INSERT INTO "Article" (id, "coverId") VALUES (${ARTICLE}, ${t.id}); ${hold(
        'Article',
        ARTICLE,
        'Dismissed'
      )}`,
  },
  {
    label: "an image connected to another entity with the held article's id",
    restricts: false,
    mark: (t) => `
      INSERT INTO "Article" (id) VALUES (${ARTICLE});
      INSERT INTO "ImageConnection" ("imageId", "entityId", "entityType") VALUES (${
        t.id
      }, ${ARTICLE}, 'Bounty');
      ${hold('Article', ARTICLE, 'Confirmed')}`,
  },
];

/** Removes every row a case writes, and the target's post. */
export const csamCaseCleanupSql = (t: Target) => `
  DELETE FROM "Image" WHERE id = ${SIBLING};
  UPDATE "Image" SET "postId" = NULL WHERE id = ${t.id};
  DELETE FROM "User" WHERE id = ${SIBLING_OWNER};
  DELETE FROM "Post" WHERE id = ${POST};
  DELETE FROM "ModelVersion" WHERE id = ${VERSION};
  DELETE FROM "PostText" WHERE id = ${TEXT};
  DELETE FROM "Article" WHERE id = ${ARTICLE};
  DELETE FROM "ImageConnection" WHERE "entityId" = ${ARTICLE};
  DELETE FROM "TextScanHold" WHERE "entityId" IN (${POST}, ${MODEL}, ${TEXT}, ${ARTICLE});
  DELETE FROM "ScanLabelFlag" WHERE "itemId" = ${ITEM};
  DELETE FROM "ScanLabelVote" WHERE "itemId" = ${ITEM};
  DELETE FROM "ScanLabelItem" WHERE id = ${ITEM};
  DELETE FROM "BlockedImage" WHERE hash = ${HASH};
`;

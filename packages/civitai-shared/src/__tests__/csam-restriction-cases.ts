/**
 * Cases for the moderator-view rule (`moderatorWithheldSql`) that every suite reading it runs
 * against its own route: rows that share the target's url, and the post-text and article holds.
 * Each `mark` is plain SQL for a PGlite whose schema includes `CSAM_LINK_TABLES_SQL`;
 * `csamCaseCleanupSql` removes what any case wrote and clears the target's post.
 */

import { CSAM_HOLD_POST_UNPUBLISH_REASON } from '../held-url';

/** The tables these cases write that the older suite schemas lack. */
export const CSAM_LINK_TABLES_SQL = `
CREATE TABLE "PostText" (id INTEGER PRIMARY KEY, "postId" INTEGER NOT NULL, "csamHeld" BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE "Article" (id INTEGER PRIMARY KEY, "coverId" INTEGER, "bannerId" INTEGER);
CREATE TABLE "ImageConnection" ("imageId" INTEGER NOT NULL, "entityId" INTEGER NOT NULL, "entityType" TEXT NOT NULL);
CREATE TABLE "ServiceOffering" (id INTEGER PRIMARY KEY, "coverImageId" INTEGER);
CREATE TABLE "UserProfile" ("userId" INTEGER PRIMARY KEY, "coverImageId" INTEGER, "sfwCoverImageId" INTEGER);
CREATE TABLE "EntityModeration" ("entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL, status TEXT NOT NULL, "triggeredLabels" TEXT[] NOT NULL DEFAULT '{}', result JSONB);
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
const OFFERING = 990990001;
const PROFILE_USER = 990910002;
const OTHER_IMAGE = 990900002;
const REPORTED_USER = 990910003;
/** Marks the reports a case writes, so the cleanup removes only those. */
const CASE_DETAILS = '{"case": "csam-restriction"}';

type Target = { id: number; url: string };
/** `held`: the case makes the target held media (`heldImageSql`), served only through a held leg. */
export type CsamCase = {
  label: string;
  restricts: boolean;
  held?: true;
  mark: (target: Target) => string;
};

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
    restricts: false,
    mark: (t) =>
      `${sibling(
        t
      )} INSERT INTO "ScanLabelItem" (id, "imageId", "voidReason") VALUES (${ITEM}, ${SIBLING}, 'csam-hold');`,
  },
  {
    // An automated review flag is a signal for review, not a CSAM mark.
    label: 'a row on its url with only an automated review flag',
    restricts: false,
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
    restricts: false,
    mark: (t) => `${sibling(t)} ${ban('SexualMinor')}`,
  },
  {
    label: 'a row on its url whose post is on an undecided csam hold',
    restricts: false,
    mark: (t) => `${post} ${sibling(t, { postId: POST })} ${hold('Post', POST, 'Pending')}`,
  },
  {
    label: 'a row on its url whose model is on a confirmed csam hold',
    restricts: false,
    mark: (t) => `
      INSERT INTO "ModelVersion" (id, meta, "modelId") VALUES (${VERSION}, '{}', ${MODEL});
      INSERT INTO "Post" (id, metadata, "modelVersionId") VALUES (${POST}, '{}', ${VERSION});
      ${sibling(t, { postId: POST })} ${hold('Model', MODEL, 'Confirmed')}`,
  },
  {
    label: "a row on its url whose post's text is on a csam hold",
    restricts: false,
    mark: (t) =>
      `${post} ${postText()} ${sibling(t, { postId: POST })} ${hold('PostText', TEXT, 'Pending')}`,
  },
  {
    label: 'a row on its url that is the cover of an article on a csam hold',
    restricts: false,
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
  {
    label: 'a row on its url blocked with no reason',
    restricts: false,
    mark: (t) => sibling(t, { ingestion: "'Blocked'", blockedFor: 'NULL' }),
  },
  {
    label: 'a row on its url with a block reason not known to be routine',
    restricts: false,
    mark: (t) => sibling(t, { ingestion: "'Blocked'", blockedFor: "'unlisted'" }),
  },
  {
    label: 'a row on its url with a routine block reason',
    restricts: false,
    mark: (t) => sibling(t, { ingestion: "'Blocked'", blockedFor: "'moderated'" }),
  },
  // The image's own post text, articles, service offerings and profiles.
  {
    label: "its post's text on a confirmed csam hold",
    restricts: false,
    mark: (t) => `${ownPost(t)} ${postText()} ${hold('PostText', TEXT, 'Confirmed')}`,
  },
  {
    label: "its post's text held for CSAM",
    restricts: false,
    mark: (t) => `${ownPost(t)} ${postText(true)}`,
  },
  {
    label: 'the cover of an article on an undecided csam hold',
    restricts: false,
    mark: (t) =>
      `INSERT INTO "Article" (id, "coverId") VALUES (${ARTICLE}, ${t.id}); ${hold(
        'Article',
        ARTICLE,
        'Pending'
      )}`,
  },
  {
    label: 'the banner of an article on a csam hold',
    restricts: false,
    mark: (t) =>
      `INSERT INTO "Article" (id, "bannerId") VALUES (${ARTICLE}, ${t.id}); ${hold(
        'Article',
        ARTICLE,
        'Confirmed'
      )}`,
  },
  {
    label: 'an image in an article on a csam hold',
    restricts: false,
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
  {
    label: 'another image in an article on a csam hold',
    restricts: false,
    mark: () => `
      INSERT INTO "Article" (id) VALUES (${ARTICLE});
      INSERT INTO "ImageConnection" ("imageId", "entityId", "entityType") VALUES (${OTHER_IMAGE}, ${ARTICLE}, 'Article');
      ${hold('Article', ARTICLE, 'Confirmed')}`,
  },
  {
    label: "the cover of an article, and a csam hold on a post with the article's id",
    restricts: false,
    mark: (t) =>
      `INSERT INTO "Article" (id, "coverId") VALUES (${ARTICLE}, ${t.id}); ${hold(
        'Post',
        ARTICLE,
        'Confirmed'
      )}`,
  },
  {
    label: "its post's text, and a csam hold on a post with the text's id",
    restricts: false,
    mark: (t) => `${ownPost(t)} ${postText()} ${hold('Post', TEXT, 'Confirmed')}`,
  },
  {
    label: 'the cover of a service offering on a csam hold',
    restricts: false,
    mark: (t) =>
      `INSERT INTO "ServiceOffering" (id, "coverImageId") VALUES (${OFFERING}, ${t.id}); ${hold(
        'ServiceOffering',
        OFFERING,
        'Pending'
      )}`,
  },
  {
    label: 'the cover of a service offering whose csam hold is dismissed',
    restricts: false,
    mark: (t) =>
      `INSERT INTO "ServiceOffering" (id, "coverImageId") VALUES (${OFFERING}, ${t.id}); ${hold(
        'ServiceOffering',
        OFFERING,
        'Dismissed'
      )}`,
  },
  {
    label: 'the cover of a profile on a csam hold',
    restricts: false,
    mark: (t) =>
      `INSERT INTO "UserProfile" ("userId", "coverImageId") VALUES (${PROFILE_USER}, ${
        t.id
      }); ${hold('UserProfile', PROFILE_USER, 'Confirmed')}`,
  },
  {
    label: 'the SFW cover of a profile on a csam hold',
    restricts: false,
    mark: (t) =>
      `INSERT INTO "UserProfile" ("userId", "sfwCoverImageId") VALUES (${PROFILE_USER}, ${
        t.id
      }); ${hold('UserProfile', PROFILE_USER, 'Pending')}`,
  },
  {
    label: 'the cover of a service offering whose csam verdict has no hold yet',
    restricts: false,
    mark: (t) =>
      `INSERT INTO "ServiceOffering" (id, "coverImageId") VALUES (${OFFERING}, ${t.id});
       INSERT INTO "EntityModeration" ("entityType", "entityId", status, "triggeredLabels", result)
       VALUES ('ServiceOffering', ${OFFERING}, 'Succeeded', '{csam}', '{"textHash": "h1"}');`,
  },
  {
    label: 'the cover of a service offering whose csam verdict a moderator dismissed',
    restricts: false,
    mark: (t) =>
      `INSERT INTO "ServiceOffering" (id, "coverImageId") VALUES (${OFFERING}, ${t.id});
       INSERT INTO "EntityModeration" ("entityType", "entityId", status, "triggeredLabels", result)
       VALUES ('ServiceOffering', ${OFFERING}, 'Succeeded', '{csam}', '{"textHash": "h1"}');
       INSERT INTO "TextScanHold" ("entityType", "entityId", label, status, "textHash")
       VALUES ('ServiceOffering', ${OFFERING}, 'csam', 'Dismissed', 'h1');`,
  },
  {
    label: "the cover of a profile, and a csam hold on a service offering with the user's id",
    restricts: false,
    mark: (t) =>
      `INSERT INTO "UserProfile" ("userId", "coverImageId") VALUES (${PROFILE_USER}, ${
        t.id
      }); ${hold('ServiceOffering', PROFILE_USER, 'Confirmed')}`,
  },
  {
    label: "the cover of a service offering, and a csam hold on a profile with the offering's id",
    restricts: false,
    mark: (t) =>
      `INSERT INTO "ServiceOffering" (id, "coverImageId") VALUES (${OFFERING}, ${t.id}); ${hold(
        'UserProfile',
        OFFERING,
        'Confirmed'
      )}`,
  },
  // Its own label item: a hold or a vote keeps it with the grant, an automated review flag alone does not.
  {
    label: 'its own label item with only an automated review flag',
    restricts: false,
    mark: (t) =>
      `${item(
        t.id
      )} INSERT INTO "ScanLabelFlag" ("itemId", snapshot) VALUES (${ITEM}, '{"csam": "true"}');`,
  },
  {
    label: 'its own label item on a csam hold',
    restricts: false,
    mark: (t) =>
      `INSERT INTO "ScanLabelItem" (id, "imageId", "voidReason") VALUES (${ITEM}, ${t.id}, 'csam-hold');`,
  },
  {
    label: 'its own label item with a csam vote',
    restricts: true,
    mark: (t) =>
      `${item(
        t.id
      )} INSERT INTO "ScanLabelVote" ("itemId", reason) VALUES (${ITEM}, 'csam-realistic');`,
  },
  // civitai/civitai#10202: item-level CSAM signals stay with the grant; owner, post, model and entity
  // signals do not.
  {
    label: 'its owner named as the subject of a CSAM report',
    restricts: false,
    held: true,
    mark: (t) =>
      `INSERT INTO "CsamReport" ("userId", details, images) SELECT "userId", '${CASE_DETAILS}', '[]' FROM "Image" WHERE id = ${t.id};`,
  },
  {
    label: 'its owner named as the secondary user of a CSAM report',
    restricts: false,
    held: true,
    mark: (t) =>
      `INSERT INTO "CsamReport" ("userId", details, images)
        SELECT ${REPORTED_USER}, '${CASE_DETAILS}'::jsonb || jsonb_build_object('secondaryUserId', "userId"::text), '[]'
        FROM "Image" WHERE id = ${t.id};`,
  },
  {
    label: 'a row on its url whose owner is named on a CSAM report',
    restricts: false,
    mark: (t) =>
      `${sibling(
        t
      )} INSERT INTO "CsamReport" ("userId", details, images) VALUES (${SIBLING_OWNER}, '${CASE_DETAILS}', '[]');`,
  },
  {
    label: 'its post unpublished by a CSAM text hold',
    restricts: false,
    mark: (t) =>
      `INSERT INTO "Post" (id, metadata, "modelVersionId") VALUES (${POST}, '{"unpublishedReason": "${CSAM_HOLD_POST_UNPUBLISH_REASON}"}', NULL);
        UPDATE "Image" SET "postId" = ${POST} WHERE id = ${t.id};`,
  },
  {
    label: 'a moderator delete on its url with no owner recorded',
    restricts: false,
    mark: (t) =>
      `INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId", "csamReview") VALUES (${OTHER_IMAGE}, '${t.url}', NULL, false);`,
  },
  {
    label: 'a shop takedown on its url with no owner recorded',
    restricts: false,
    mark: (t) =>
      `INSERT INTO "ImageCdnShopTakedown" (url, "shopItemId", "userId") VALUES ('${t.url}', ${OFFERING}, NULL);`,
  },
  // Item-level marks.
  {
    label: 'a row on its url in the CSAM review queue',
    restricts: true,
    mark: (t) => sibling(t, { needsReview: "'csam'" }),
  },
  {
    label: 'its listing on a CSAM report',
    restricts: true,
    mark: (t) =>
      `INSERT INTO "CsamReport" ("userId", details, images) VALUES (${REPORTED_USER}, '${CASE_DETAILS}', jsonb_build_array(jsonb_build_object('id', ${t.id})));`,
  },
  {
    label: 'a moderator delete on its url flagged for CSAM review',
    restricts: false,
    mark: (t) =>
      `INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId", "csamReview") VALUES (${OTHER_IMAGE}, '${t.url}', ${SIBLING_OWNER}, true);`,
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
  DELETE FROM "ServiceOffering" WHERE id = ${OFFERING};
  DELETE FROM "EntityModeration" WHERE "entityId" = ${OFFERING};
  DELETE FROM "UserProfile" WHERE "userId" = ${PROFILE_USER};
  DELETE FROM "TextScanHold"
    WHERE "entityId" IN (${POST}, ${MODEL}, ${TEXT}, ${ARTICLE}, ${OFFERING}, ${PROFILE_USER});
  DELETE FROM "ScanLabelFlag" WHERE "itemId" = ${ITEM};
  DELETE FROM "ScanLabelVote" WHERE "itemId" = ${ITEM};
  DELETE FROM "ScanLabelItem" WHERE id = ${ITEM};
  DELETE FROM "BlockedImage" WHERE hash = ${HASH};
  DELETE FROM "CsamReport" WHERE details ->> 'case' = 'csam-restriction';
  DELETE FROM "ImageCdnModeratorDelete" WHERE "imageId" = ${OTHER_IMAGE};
  DELETE FROM "ImageCdnShopTakedown" WHERE "shopItemId" = ${OFFERING};
`;

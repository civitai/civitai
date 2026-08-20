import { sql } from '@civitai/db/kysely';
import { reportEntityLabels, type ReportEntity } from '$lib/reports';

/**
 * Where each report type's rows live, and who owns the thing being reported.
 *
 * This was two maps of one fact: `reportEntityJoin` (report table + fk, keyed by `ReportEntity`) and
 * `REPORT_SOURCES` (label + entity table + report table + fk, as tuples, minus the two types that
 * cannot join by `userId`). Adding a report type meant editing both plus a hand-spliced arm in the
 * board — and the most-reported query shipped covering five of fifteen types precisely because a
 * second list of the same thing is a list that can be short.
 */
export type ReportEntityMeta = {
  type: ReportEntity;
  /** Where the report's own row lives, and its foreign key to the reported thing. */
  reportTable: string;
  fk: string;
  /** The reported thing's own table. */
  table: string;
  /** Column on `table` naming the account the report is ABOUT. `null` where no single column says
   *  that: `reportedUser` (the reported thing IS an account) and `chat`, whose subject is inferred by
   *  `chatReportSubject` and added back at both `OWNED_REPORT_ENTITIES` call sites. */
  ownerColumn: 'userId' | 'ownerId' | null;
  label: string;
};

// Declaration order is display order wherever reports are grouped by type.
const TABLES: Record<ReportEntity, Omit<ReportEntityMeta, 'type' | 'label'>> = {
  image: { reportTable: 'ImageReport', fk: 'imageId', table: 'Image', ownerColumn: 'userId' },
  model: { reportTable: 'ModelReport', fk: 'modelId', table: 'Model', ownerColumn: 'userId' },
  post: { reportTable: 'PostReport', fk: 'postId', table: 'Post', ownerColumn: 'userId' },
  article: {
    reportTable: 'ArticleReport',
    fk: 'articleId',
    table: 'Article',
    ownerColumn: 'userId',
  },
  comment: {
    reportTable: 'CommentReport',
    fk: 'commentId',
    table: 'Comment',
    ownerColumn: 'userId',
  },
  commentV2: {
    reportTable: 'CommentV2Report',
    fk: 'commentV2Id',
    table: 'CommentV2',
    ownerColumn: 'userId',
  },
  bounty: { reportTable: 'BountyReport', fk: 'bountyId', table: 'Bounty', ownerColumn: 'userId' },
  bountyEntry: {
    reportTable: 'BountyEntryReport',
    fk: 'bountyEntryId',
    table: 'BountyEntry',
    ownerColumn: 'userId',
  },
  collection: {
    reportTable: 'CollectionReport',
    fk: 'collectionId',
    table: 'Collection',
    ownerColumn: 'userId',
  },
  resourceReview: {
    reportTable: 'ResourceReviewReport',
    fk: 'resourceReviewId',
    table: 'ResourceReview',
    ownerColumn: 'userId',
  },
  comicProject: {
    reportTable: 'ComicProjectReport',
    fk: 'comicProjectId',
    table: 'ComicProject',
    ownerColumn: 'userId',
  },
  model3d: {
    reportTable: 'Model3DReport',
    fk: 'model3dId',
    table: 'Model3D',
    ownerColumn: 'userId',
  },
  model3dReview: {
    reportTable: 'Model3DReviewReport',
    fk: 'model3dReviewId',
    table: 'Model3DReview',
    ownerColumn: 'userId',
  },
  // `ownerId` is who OPENED the conversation, which is not who was reported — see
  // `chatReportSubject`. Null keeps it out of the owner-column loop; both call sites add it back with
  // that predicate.
  chat: { reportTable: 'ChatReport', fk: 'chatId', table: 'Chat', ownerColumn: null },
  reportedUser: { reportTable: 'UserReport', fk: 'userId', table: 'User', ownerColumn: null },
};

export const REPORT_ENTITIES: ReportEntityMeta[] = (Object.keys(TABLES) as ReportEntity[]).map(
  (type) => ({ type, ...TABLES[type], label: reportEntityLabels[type] })
);

const BY_TYPE = new Map(REPORT_ENTITIES.map((e) => [e.type, e]));

export const reportEntity = (type: ReportEntity): ReportEntityMeta => BY_TYPE.get(type)!;

/**
 * Which account a chat report is ABOUT, as a predicate over a joined `Chat` and its `Report`.
 *
 * `ChatReport` is `(chatId, reportId)` — no message pointer, no accused-user pointer — so a report
 * names a *conversation*, not a person, and every answer here is an inference. Two obvious ones are
 * both wrong:
 *
 * - **The chat owner** (what this used to do). `Chat.ownerId` is whoever opened the thread. Usually
 *   that is the sender of an unsolicited DM, which is why it looks right — but on 122 of the 2,241
 *   human-filed chat reports the owner IS the reporter, so the screen credited the person who
 *   complained and showed nothing against the account they complained about.
 * - **Anyone who sent a message** (what Retool's `query152` did). That always includes the reporter,
 *   so every harassment report also marks the victim as having reported content.
 *
 * The sound reading is the participant who is NOT a reporter, and it is only unambiguous when there
 * is exactly one of them: a two-party chat whose reporter is the other member.
 *
 * 🔴 **The reporter-is-a-member clause is load-bearing, not belt-and-braces.** `Automated` reports are
 * filed by user `-1`, who is in no chat — so without it BOTH parties satisfy every other clause, and
 * since automated reports are 96% of this table the predicate attributed **121,148** reports across
 * **20,452** accounts instead of 2,226 across 1,186. Every account that had ever *received* an
 * auto-flagged DM read as having reported content. Do not drop it as redundant.
 *
 * Yields exactly one account per report: 2,226 attributions from 2,226 distinct reports. Group chats
 * match nobody — the report cannot be pinned on one of N members.
 *
 * ⚠️ **Membership counts at every `ChatMember.status`, deliberately.** Narrowing to `Joined` looks
 * tidier and drops the result to 751: the recipient of an unsolicited DM is usually `Invited`,
 * `Ignored` or `Left`, which is precisely the harassment case this exists to find.
 *
 * Measured against production 2026-08-20.
 */
export const chatReportSubject = (
  chatIdCol: string,
  reportAlias: string,
  userId: number
) => sql<boolean>`
  ${sql.ref(reportAlias)}."userId" <> ${userId}
  AND NOT (${userId} = ANY(${sql.ref(reportAlias)}."alsoReportedBy"))
  AND EXISTS (
    SELECT 1 FROM "ChatMember" cm
    WHERE cm."chatId" = ${sql.ref(chatIdCol)} AND cm."userId" = ${userId}
  )
  AND EXISTS (
    SELECT 1 FROM "ChatMember" rm
    WHERE rm."chatId" = ${sql.ref(chatIdCol)} AND rm."userId" = ${sql.ref(reportAlias)}."userId"
  )
  AND (SELECT count(*) FROM "ChatMember" cm2 WHERE cm2."chatId" = ${sql.ref(chatIdCol)}) = 2
`;

/** Every type whose row names its owner in one column — i.e. all but `reportedUser` (the reported
 *  thing IS an account) and `chat` (no single column says it; see `chatReportSubject`). */
export const OWNED_REPORT_ENTITIES = REPORT_ENTITIES.filter(
  (e): e is ReportEntityMeta & { ownerColumn: 'userId' | 'ownerId' } => e.ownerColumn !== null
);

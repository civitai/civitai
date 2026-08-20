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
  /** Column on `table` naming the account that owns it. `null` where the reported thing IS an
   *  account — the one type that is not somebody's content. */
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
  // Owns by `ownerId`, so it cannot join a `userId` loop — the reason it used to be a separate export.
  chat: { reportTable: 'ChatReport', fk: 'chatId', table: 'Chat', ownerColumn: 'ownerId' },
  reportedUser: { reportTable: 'UserReport', fk: 'userId', table: 'User', ownerColumn: null },
};

export const REPORT_ENTITIES: ReportEntityMeta[] = (Object.keys(TABLES) as ReportEntity[]).map(
  (type) => ({ type, ...TABLES[type], label: reportEntityLabels[type] })
);

const BY_TYPE = new Map(REPORT_ENTITIES.map((e) => [e.type, e]));

export const reportEntity = (type: ReportEntity): ReportEntityMeta => BY_TYPE.get(type)!;

/** Everything a user can OWN — i.e. every type except an account itself. */
export const OWNED_REPORT_ENTITIES = REPORT_ENTITIES.filter(
  (e): e is ReportEntityMeta & { ownerColumn: 'userId' | 'ownerId' } => e.ownerColumn !== null
);

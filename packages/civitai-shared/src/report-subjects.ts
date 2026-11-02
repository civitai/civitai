/**
 * Report types whose reported row names the account the report is about in one column: the report's
 * join table, its key to the reported row, that row's table and its owner column. The main app reads
 * it to check a report concerns a user; the moderator app's report queues hold the same list and a
 * parity test there keeps the two equal. `UserReport` and `ChatReport` have no owner column and are
 * resolved separately.
 */
export const OWNED_REPORT_TABLES = [
  { reportTable: 'ImageReport', fk: 'imageId', table: 'Image', ownerColumn: 'userId' },
  { reportTable: 'ModelReport', fk: 'modelId', table: 'Model', ownerColumn: 'userId' },
  { reportTable: 'PostReport', fk: 'postId', table: 'Post', ownerColumn: 'userId' },
  { reportTable: 'ArticleReport', fk: 'articleId', table: 'Article', ownerColumn: 'userId' },
  { reportTable: 'CommentReport', fk: 'commentId', table: 'Comment', ownerColumn: 'userId' },
  { reportTable: 'CommentV2Report', fk: 'commentV2Id', table: 'CommentV2', ownerColumn: 'userId' },
  { reportTable: 'BountyReport', fk: 'bountyId', table: 'Bounty', ownerColumn: 'userId' },
  {
    reportTable: 'BountyEntryReport',
    fk: 'bountyEntryId',
    table: 'BountyEntry',
    ownerColumn: 'userId',
  },
  {
    reportTable: 'CollectionReport',
    fk: 'collectionId',
    table: 'Collection',
    ownerColumn: 'userId',
  },
  {
    reportTable: 'ResourceReviewReport',
    fk: 'resourceReviewId',
    table: 'ResourceReview',
    ownerColumn: 'userId',
  },
  {
    reportTable: 'ComicProjectReport',
    fk: 'comicProjectId',
    table: 'ComicProject',
    ownerColumn: 'userId',
  },
  { reportTable: 'Model3DReport', fk: 'model3dId', table: 'Model3D', ownerColumn: 'userId' },
  {
    reportTable: 'Model3DReviewReport',
    fk: 'model3dReviewId',
    table: 'Model3DReview',
    ownerColumn: 'userId',
  },
  {
    reportTable: 'AnnouncementReport',
    fk: 'announcementId',
    table: 'Announcement',
    ownerColumn: 'userId',
  },
  { reportTable: 'CrucibleReport', fk: 'crucibleId', table: 'Crucible', ownerColumn: 'userId' },
  { reportTable: 'StorylineReport', fk: 'storylineId', table: 'Storyline', ownerColumn: 'userId' },
  {
    reportTable: 'ServiceOfferingReport',
    fk: 'serviceOfferingId',
    table: 'ServiceOffering',
    ownerColumn: 'sellerId',
  },
  {
    reportTable: 'ChallengeReport',
    fk: 'challengeId',
    table: 'Challenge',
    ownerColumn: 'createdById',
  },
  {
    reportTable: 'GameFrameGameReport',
    fk: 'gameFrameGameId',
    table: 'GameFrameGame',
    ownerColumn: 'userId',
  },
] as const;

export type OwnedReportTable = (typeof OWNED_REPORT_TABLES)[number];

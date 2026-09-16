export enum ReportEntity {
  Model = 'model',
  Comment = 'comment',
  CommentV2 = 'commentV2',
  Image = 'image',
  ResourceReview = 'resourceReview',
  Article = 'article',
  Post = 'post',
  User = 'reportedUser',
  Collection = 'collection',
  Challenge = 'challenge',
  Bounty = 'bounty',
  BountyEntry = 'bountyEntry',
  Chat = 'chat',
  ComicProject = 'comicProject',
  Model3D = 'model3d',
  Model3DReview = 'model3dReview',
  Announcement = 'announcement',
}

/**
 * What to call each reportable thing when telling a user what they just reported.
 *
 * 🔴 Not `getDisplayName`. That returns the enum value with its capitalisation as authored, so
 * most of these come back lowercase ("model", "announcement") and the camelCase ones come back
 * half-split ("reported User", "bounty Entry") — a toast reading "announcement reported". Its
 * `nameOverrides` does fix `commentV2` and `model3d`, which is why the breakage looks partial.
 * Typed `Record`, not `Partial`, so a new entity without a label is a type error rather than a
 * toast reading "undefined reported".
 */
export const reportEntityLabels: Record<ReportEntity, string> = {
  [ReportEntity.Model]: 'Model',
  [ReportEntity.Comment]: 'Comment',
  [ReportEntity.CommentV2]: 'Comment',
  [ReportEntity.Image]: 'Image',
  [ReportEntity.ResourceReview]: 'Review',
  [ReportEntity.Article]: 'Article',
  [ReportEntity.Post]: 'Post',
  [ReportEntity.User]: 'User',
  [ReportEntity.Collection]: 'Collection',
  [ReportEntity.Challenge]: 'Challenge',
  [ReportEntity.Bounty]: 'Bounty',
  [ReportEntity.BountyEntry]: 'Bounty entry',
  [ReportEntity.Chat]: 'Chat',
  [ReportEntity.ComicProject]: 'Comic',
  [ReportEntity.Model3D]: '3D model',
  [ReportEntity.Model3DReview]: '3D review',
  [ReportEntity.Announcement]: 'Announcement',
};

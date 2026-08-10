// The entity types a user's own content can be reported under, as `[label, table, reportTable, fk]`.
//
// One list, because two consumers read it for the same question: `user-lookup.service.ts` counts the
// distinct reported items per type and `user-reports.service.ts` fetches the rows behind those counts.
// Written twice, adding a type to one and not the other makes the Reports section state a count it
// cannot then show rows for.
export const REPORT_SOURCES = [
  ['Image', 'Image', 'ImageReport', 'imageId'],
  ['Model', 'Model', 'ModelReport', 'modelId'],
  ['Post', 'Post', 'PostReport', 'postId'],
  ['Article', 'Article', 'ArticleReport', 'articleId'],
  ['Comment', 'Comment', 'CommentReport', 'commentId'],
  ['CommentV2', 'CommentV2', 'CommentV2Report', 'commentV2Id'],
  ['Bounty', 'Bounty', 'BountyReport', 'bountyId'],
  ['BountyEntry', 'BountyEntry', 'BountyEntryReport', 'bountyEntryId'],
  ['Collection', 'Collection', 'CollectionReport', 'collectionId'],
  ['ResourceReview', 'ResourceReview', 'ResourceReviewReport', 'resourceReviewId'],
  // Newer than Retool's eleven, and reachable the same way — all three own by `userId`. Leaving them
  // out reproduces exactly the count-vs-rows disagreement this list exists to prevent.
  ['Comic', 'ComicProject', 'ComicProjectReport', 'comicProjectId'],
  ['3D Model', 'Model3D', 'Model3DReport', 'model3dId'],
  ['3D Review', 'Model3DReview', 'Model3DReviewReport', 'model3dReviewId'],
] as const;

/** `Chat` owns by `ownerId`, not `userId`, so it cannot join through the loop above. Reported chats
 *  are fetched separately rather than left invisible. */
export const CHAT_REPORT_SOURCE = ['Chat', 'Chat', 'ChatReport', 'chatId'] as const;

export type ReportSource = (typeof REPORT_SOURCES)[number];

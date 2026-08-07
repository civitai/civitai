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
] as const;

export type ReportSource = (typeof REPORT_SOURCES)[number];

/**
 * The one definition of the v1 model-comment permalink — the URL that opens the `commentThread`
 * routed dialog for a model comment (declared in `routed-dialog/comment-thread.dialog.ts`).
 * Shared by the client "Copy link" action and the server notification processors so the query
 * scheme has a single owner. NOT the CommentsV2 permalink — that one is `threadUrlMap` /
 * `buildCommentPermalink` in `server/utils/comment-permalink.ts`.
 */
export function getModelCommentThreadUrl({
  modelId,
  commentId,
  highlight,
}: {
  modelId: number;
  commentId: number;
  highlight?: number | null;
}) {
  const base = `/models/${modelId}?dialog=commentThread&commentId=${commentId}`;
  return highlight ? `${base}&highlight=${highlight}` : base;
}

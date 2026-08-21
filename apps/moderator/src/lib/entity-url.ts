import {
  moderatorBulkImageManagerPath,
  moderatorUserLookupPath,
} from '@civitai/shared/moderator-paths';

// Entity type → the main app's URL segment for it. Shared because the dashboard and User Lookup both
// render moderator-activity rows, and their private copies had already drifted: the lookup's was missing
// `post`, so a post action rendered as unlinked text there and as a link on the dashboard.
const ENTITY_PATH: Record<string, string> = {
  image: 'images',
  model: 'models',
  post: 'posts',
  article: 'articles',
  bounty: 'bounties',
  // The report pages knew these four and this map did not, so a Collection or ResourceReview report
  // rendered as a working link on /reports and as dead grey text in User Lookup.
  collection: 'collections',
  resourcereview: 'reviews',
  comicproject: 'comics',
  model3d: '3d-models',
};

// Callers disagree on casing — ModActivity stores 'image', the report joins label rows 'Image', and
// thread resolution yields 'bountyEntry'. Matching case-sensitively silently returned null for one of
// them, which reads as "no link exists" rather than "the key was spelled differently".
//
// Types with no standalone page (comments, bounty entries, questions, answers, reviews, accounts)
// have no entry and correctly return null.
export function entityUrl(
  civitaiUrl: string,
  entityType: string | null,
  entityId: number | null
): string | null {
  const segment = entityType ? ENTITY_PATH[entityType.toLowerCase()] : undefined;
  return entityId && segment ? `${civitaiUrl}/${segment}/${entityId}` : null;
}

// Linking a comment to its ENTITY leaves the moderator scrolling a thread for the row they were already
// looking at. Both comment tables have a deep link and neither is derivable from `entityUrl`.

/** Legacy `Comment` (model threads): opens the thread dialog with the row highlighted. */
export const modelCommentUrl = (civitaiUrl: string, modelId: number, commentId: number) =>
  `${civitaiUrl}/models/${modelId}?dialog=commentThread&highlight=${commentId}`;

/** `CommentV2` (image, article, post, bounty, …). The main app resolves the thread server-side and
 *  redirects with the comment pinned, so this works for entity types that have no standalone page and
 *  for replies buried past the first page of a thread — neither of which a built URL can reach. */
export const commentV2Url = (civitaiUrl: string, commentId: number) =>
  `${civitaiUrl}/comments/v2/${commentId}`;

/** A user's profile, optionally a section of it (`models`, `images`, `posts`, …). Encoded — usernames
 *  allow characters that change the path when left raw, which the previous `$lib/articles` copy did. */
export function userUrl(civitaiUrl: string, username: string, section?: string | null): string {
  const base = `${civitaiUrl}/user/${encodeURIComponent(username)}`;
  return section ? `${base}/${section}` : base;
}

// The `/retool/*` builders live in `@civitai/shared/moderator-paths` so this app and the main app read
// ONE definition. They were two, each carrying a comment telling the reader to keep them in step, and
// they had already diverged on whether user-lookup takes a `section`. When the transitional namespace
// moves, the copy nobody updated is the one that becomes a dead link.
export const userLookupUrl = moderatorUserLookupPath;
export const bulkImageManagerUrl = moderatorBulkImageManagerPath;

export const chatAuditChatUrl = (chatId: number) => `/retool/chat-audit/chats?chat=${chatId}`;

/**
 * Chat Audit searched for one account's chats.
 *
 * The leading `@` is a contract with `classifySearch`, not decoration: a bare term is classified by
 * SHAPE, so an all-digit username reads as a chat id and a non-matching one falls through to
 * message-content search.
 *
 * 🔴 This finds chats the account **posted in**, not chats it is a member of — the search joins
 * `ChatMessage`, while membership lives in `ChatMember`. An account that received DMs and never
 * replied is in N chats and matches none of them, so do not label a link to this "every chat".
 */
export const chatAuditUserUrl = (username: string) =>
  `/retool/chat-audit/chats?q=${encodeURIComponent('@' + username)}`;

/** A model page pinned to one version. Built inline at four sites before this; the version is the whole
 *  point on the moderation pages, and dropping it lands the reviewer on whichever version is current. */
export const modelVersionUrl = (civitaiUrl: string, modelId: number, versionId: number) =>
  `${civitaiUrl}/models/${modelId}?modelVersionId=${versionId}`;

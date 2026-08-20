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

/** `/retool/*` is documented as a transitional namespace, and this path was hardcoded at nine sites
 *  across three pages. When it moves, those become silent dead links.
 *
 *  `section` is a slug from `user-lookup/sections.ts` (`reports`, `notes`, …). Without one the bare
 *  route redirects to the default section, so a link that means "their reports" must say so. */
export const userLookupUrl = (idOrUsername: number | string, section?: string) => {
  const q = `?q=${encodeURIComponent(String(idOrUsername))}`;
  return section ? `/retool/user-lookup/${section}${q}` : `/retool/user-lookup${q}`;
};

/** A model page pinned to one version. Built inline at four sites before this; the version is the whole
 *  point on the moderation pages, and dropping it lands the reviewer on whichever version is current. */
export const modelVersionUrl = (civitaiUrl: string, modelId: number, versionId: number) =>
  `${civitaiUrl}/models/${modelId}?modelVersionId=${versionId}`;

// Entity type → the main app's URL segment for it. Shared because the dashboard and User Lookup both
// render moderator-activity rows, and their private copies had already drifted: the lookup's was missing
// `post`, so a post action rendered as unlinked text there and as a link on the dashboard.
const ENTITY_PATH: Record<string, string> = {
  image: 'images',
  model: 'models',
  post: 'posts',
  article: 'articles',
  bounty: 'bounties',
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

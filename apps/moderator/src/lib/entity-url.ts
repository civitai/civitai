// Entity type → the main app's URL segment for it. Shared because the dashboard and User Lookup both
// render moderator-activity rows, and their private copies had already drifted: the lookup's was missing
// `post`, so a post action rendered as unlinked text there and as a link on the dashboard.
const ENTITY_PATH: Record<string, string> = {
  image: 'images',
  model: 'models',
  post: 'posts',
  article: 'articles',
};

export function entityUrl(
  civitaiUrl: string,
  entityType: string,
  entityId: number | null
): string | null {
  const segment = ENTITY_PATH[entityType];
  return entityId && segment ? `${civitaiUrl}/${segment}/${entityId}` : null;
}

/** A user's profile, optionally a section of it (`models`, `images`, `posts`, …). Encoded — usernames
 *  allow characters that change the path when left raw, which the previous `$lib/articles` copy did. */
export function userUrl(civitaiUrl: string, username: string, section?: string | null): string {
  const base = `${civitaiUrl}/user/${encodeURIComponent(username)}`;
  return section ? `${base}/${section}` : base;
}

/** `/retool/*` is documented as a transitional namespace, and this path was hardcoded at nine sites
 *  across three pages. When it moves, those become silent dead links. */
export const userLookupUrl = (idOrUsername: number | string) =>
  `/retool/user-lookup?q=${encodeURIComponent(String(idOrUsername))}`;

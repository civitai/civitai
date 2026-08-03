/**
 * PUBLIC OWNER CHIP projection (pure).
 *
 * The `blocks.getAppDetail` (legacy `/apps/<appBlockId>`) read needs the app's
 * real OWNER so the page can attribute it to a person. Before this, the page
 * rendered `by {appName}` — and because every approved block's `OauthClient.name`
 * equals the app's own title, the AUTHOR slot showed the APP TITLE (verified in
 * prod: `appblk-gen-matrix` → OauthClient name "Gen Matrix", real owner
 * `zachlowdenzx`).
 *
 * 🔒 EXPLICIT ALLOWLIST. The owner is a real user row; this projection is the
 * only thing standing between it and an anon-capable public read, so it shapes
 * EXACTLY `{id, username, image}` — the same subset the unified store's
 * `ListingCreatorChip` exposes (`app-listing.service.ts::creatorChip`). Nothing
 * else (email, settings, flags, muted/banned state, …) can leak, because nothing
 * else is ever copied. Adding a field here is a deliberate act.
 *
 * `username` is nullable in the DB, so it stays nullable here and the UI must
 * handle it (it renders no attribution line rather than inventing one).
 */

export type PublicOwnerChip = {
  id: number;
  username: string | null;
  image: string | null;
};

/**
 * Project a raw joined owner row → the public chip, or `null` when there is no
 * resolvable owner (LEFT JOIN miss / deleted user). Defensive about types: the
 * row comes from `$queryRaw`, which is `unknown`-shaped at runtime.
 */
export function projectPublicOwner(row: {
  owner_user_id?: unknown;
  owner_username?: unknown;
  owner_image?: unknown;
}): PublicOwnerChip | null {
  const id = row.owner_user_id;
  if (typeof id !== 'number' || !Number.isFinite(id)) return null;
  return {
    id,
    username: typeof row.owner_username === 'string' ? row.owner_username : null,
    image: typeof row.owner_image === 'string' ? row.owner_image : null,
  };
}

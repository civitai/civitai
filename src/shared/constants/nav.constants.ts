/**
 * The sub-nav item keys, in default order. Lives in `shared/` because both the zod schema that
 * validates a user's saved config (`server/schema/user.schema.ts`) and the client registry
 * (`components/HomeContentToggle/nav-registry.ts`) have to agree on the set, and neither may
 * import the other.
 *
 * Adding a key here is not enough to make an item appear — it needs a registry entry too, and the
 * registry's `key` field is typed against this list so the two cannot drift.
 */
export const NAV_KEYS = [
  'home',
  'models',
  'images',
  'videos',
  '3d-models',
  'hubs',
  'posts',
  'articles',
  'comics',
  'bounties',
  'challenges',
  'events',
  'updates',
  'shop',
  'leaderboard',
  'auctions',
  'vault',
  'collections',
] as const;

export type NavKey = (typeof NAV_KEYS)[number];

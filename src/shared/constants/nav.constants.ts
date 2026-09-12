/**
 * The SET of sub-nav item keys. Lives in `shared/` because both the zod schema that validates a
 * user's saved config (`server/schema/user.schema.ts`) and the client registry
 * (`components/HomeContentToggle/nav-registry.ts`) have to agree on the set, and neither may
 * import the other.
 *
 * 🔴 The ORDER here carries NO meaning — display order lives in `navRegistry`, which is the only
 * thing `resolveNavItems` reads. Both consumers of this list use it as a set: `user.schema.ts`
 * builds `z.enum(NAV_KEYS)` (membership) plus a `.max(NAV_KEYS.length)`, and `NavKey` below is a
 * union, which is order-irrelevant. The list is kept roughly parallel to the registry as a
 * READING convenience, and nothing enforces that — deliberately, because pinning an order that
 * affects no behaviour would tax every future nav item with a two-file index match for nothing.
 * This docstring used to claim the keys were listed "in default order"; they were not, and
 * nothing could have told you.
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
  'apps',
  'events',
  'updates',
  'shop',
  'leaderboard',
  'auctions',
  'vault',
  'collections',
] as const;

export type NavKey = (typeof NAV_KEYS)[number];

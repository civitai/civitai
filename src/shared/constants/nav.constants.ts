/**
 * The SET of sub-nav item keys. Lives in `shared/` because both the zod schema that validates a
 * user's saved config (`server/schema/user.schema.ts`) and the client registry
 * (`components/HomeContentToggle/nav-registry.ts`) have to agree on the set, and neither may
 * import the other.
 *
 * 🔴 The ORDER here carries NO runtime meaning — display order lives in `navRegistry`, which is
 * the only thing `resolveNavItems` reads. Both consumers of this list use it as a set:
 * `user.schema.ts` builds `z.enum(NAV_KEYS)` (membership) plus a `.max(NAV_KEYS.length)`, and
 * `NavKey` below is a union, which is order-irrelevant. Nothing reads it positionally.
 *
 * As it happens the list IS currently element-for-element identical to `navRegistry`'s key order,
 * and that is worth keeping as a reading convenience — but it is a convention, not an invariant,
 * and nothing enforces it. A guard was deliberately NOT added: pinning an order that affects no
 * behaviour would tax every future nav item with a two-file index match to keep the suite green.
 *
 * This docstring used to say the keys were listed "in default order". That was imprecise in a way
 * worth naming, and NOT because the two lists disagree — they do not. It is that registry order is
 * not the order a user SEES by default: `bounties` defaults to the More menu and several entries
 * default to hidden, so the rendered bar is a filtered subset in registry order, never this list.
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

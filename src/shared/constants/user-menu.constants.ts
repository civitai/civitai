/**
 * The SET of user-menu item ids. Lives in `shared/` because the zod schema that validates a user's
 * saved pins (`server/schema/user.schema.ts`) and the client item registry
 * (`components/AppLayout/AppHeader/UserMenuV2`) have to agree on it, and neither may import the
 * other.
 *
 * Removing an id is safe for saved pins: reads are not parsed, so a stale id is skipped at render,
 * and the pins hook filters it out of the next write.
 */
export const USER_MENU_ITEM_IDS = [
  'profile',
  'inventory',
  'prizes',
  'my-shop',
  'service-requests',
  'placements',
  'training',
  'collections',
  'liked-models',
  'bookmarked-articles',
  'bounties',
  'challenges',
  'browse-challenges',
  'crucibles',
  'buzz-dashboard',
  'creator-studio',
  'creator-journey',
  'vault',
  'referrals',
  'apps',
  'leaderboard',
  'auctions',
  'knights-of-new',
  'link-app',
  'following',
  'downloads',
  'getting-started',
  'civitai-link',
  'sign-in',
  'support-report-bug',
  'support-education',
  'support-faq',
  'support-discord',
  'support-assistant',
  'support-portal',
] as const;

export type UserMenuItemId = (typeof USER_MENU_ITEM_IDS)[number];

/**
 * The items whose row carries a count of things waiting on the viewer, and whose count lights the
 * avatar. Each can be muted, and the muted ids are saved by id like pins.
 */
export const USER_MENU_BADGE_ITEM_IDS = [
  'inventory',
  'placements',
  'collections',
  'prizes',
] as const satisfies readonly UserMenuItemId[];

export type UserMenuBadgeItemId = (typeof USER_MENU_BADGE_ITEM_IDS)[number];

const BADGE_IDS: ReadonlySet<string> = new Set(USER_MENU_BADGE_ITEM_IDS);
export const isUserMenuBadgeItemId = (id: unknown): id is UserMenuBadgeItemId =>
  typeof id === 'string' && BADGE_IDS.has(id);

/**
 * What a viewer with no saved pins sees when the `userMenuDefaultPins` KeyValue row is absent,
 * unreadable, or not loaded yet. The row is the source of truth; change defaults there.
 */
export const DEFAULT_USER_MENU_PINS: UserMenuItemId[] = ['collections', 'profile'];

const KNOWN_IDS: ReadonlySet<string> = new Set(USER_MENU_ITEM_IDS);
export const isUserMenuItemId = (id: unknown): id is UserMenuItemId =>
  typeof id === 'string' && KNOWN_IDS.has(id);

/**
 * Reads the hand-edited KeyValue row. Unknown ids are dropped, so a typo or a retired item costs
 * one pin, not the menu; a row with no usable id at all is treated as a mistake and gives the
 * fallback. An empty array is honoured: it means no default pins.
 */
export function parseUserMenuDefaultPins(value: unknown): UserMenuItemId[] {
  if (!Array.isArray(value)) return DEFAULT_USER_MENU_PINS;
  const pins = [...new Set(value.filter(isUserMenuItemId))];
  return pins.length || !value.length ? pins : DEFAULT_USER_MENU_PINS;
}

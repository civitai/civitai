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
  'placements',
  'training',
  'collections',
  'liked-models',
  'bookmarked-articles',
  'bounties',
  'challenges',
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

export const DEFAULT_USER_MENU_PINS: UserMenuItemId[] = ['inventory', 'prizes'];

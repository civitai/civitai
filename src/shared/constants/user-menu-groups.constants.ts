/**
 * The user menu's group ids. Shared because the menu layout (`UserMenuV2/user-menu.layout.ts`)
 * names its groups with them and the `UserMenu_Click` tracking schema
 * (`server/schema/track.schema.ts`) accepts them, and the schema may not import the layout, which
 * pulls in icons.
 */
export const USER_MENU_GROUP_IDS = [
  'create',
  'your-stuff',
  'creator-tools',
  'rewards',
  'help',
] as const;

export type UserMenuGroupId = (typeof USER_MENU_GROUP_IDS)[number];

/** Tracking only: the fixed profile and Buzz rows above the menu, which no layout group holds. */
export const USER_MENU_HEADER_GROUP = 'header';

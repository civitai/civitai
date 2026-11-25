import type { ProfileHideableTab } from '~/server/schema/user-profile.schema';
import { profileHideableTabs } from '~/server/schema/user-profile.schema';

const hideableTabs = new Set<string>(profileHideableTabs);

export const isProfileHideableTab = (key: string): key is ProfileHideableTab =>
  hideableTabs.has(key);

/**
 * Disables the nav tabs the profile owner hid, for everyone but moderators. Hiding is a nav choice, not
 * privacy: the tab pages still resolve by URL. Keys outside `profileHideableTabs` (Overview, Shop,
 * About) are never touched, whatever the stored list holds.
 */
export function applyHiddenProfileTabs<T extends { disabled?: boolean }>(
  tabs: Record<string, T>,
  {
    hiddenTabs,
    viewerSeesAll,
    enabled,
  }: {
    hiddenTabs: readonly string[] | null | undefined;
    /** Moderators. */
    viewerSeesAll: boolean;
    /** `profileRedesign` for the viewer. */
    enabled: boolean;
  }
): Record<string, T> {
  if (!enabled || viewerSeesAll || !hiddenTabs?.length) return tabs;
  const hidden = new Set<string>(hiddenTabs.filter(isProfileHideableTab));
  return Object.fromEntries(
    Object.entries(tabs).map(([key, tab]) => [
      key,
      hidden.has(key) ? { ...tab, disabled: true } : tab,
    ])
  );
}

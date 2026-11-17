import {
  DEFAULT_BROWSING_SETTINGS_ADDONS,
  type BrowsingSettingsAddon,
} from '~/shared/constants/browsing-settings-addons';
import { getBlockedBrowsingTags, getBrowsingSettingAddons } from '~/server/services/system-cache';

/**
 * Every tag id a browsing rule can hide content by: the blocked browsing tags and the
 * `excludedTagIds` of every browsing-settings addon at any level, live and default. Returns null
 * when the live lists cannot be read; a caller then keeps every tag.
 */
export async function getImageTagGateIds(): Promise<Set<number> | null> {
  try {
    const [blocked, addons] = await Promise.all([
      getBlockedBrowsingTags(),
      getBrowsingSettingAddons(),
    ]);
    const ids = new Set<number>(blocked.map((t) => t.id));
    const addTagIds = (list: readonly BrowsingSettingsAddon[]) => {
      for (const addon of list) for (const id of addon.excludedTagIds ?? []) ids.add(id);
    };
    addTagIds(DEFAULT_BROWSING_SETTINGS_ADDONS);
    addTagIds(addons);
    return ids;
  } catch {
    return null;
  }
}

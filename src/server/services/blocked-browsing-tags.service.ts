import {
  onlySelectableLevels,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { ResolvedBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { getBlockedBrowsingTags, getBrowsingSettingAddons } from '~/server/services/system-cache';
import { isBlockedTagName, stripBlockedTagIds } from '~/server/utils/blocked-browsing-tags';

type AddonTarget = {
  excludedTagIds?: number[];
  disablePoi?: boolean;
  disableMinor?: boolean;
  userId?: number;
  username?: string;
  browsingLevel?: number;
};

type Viewer = { id?: number; username?: string | null; isModerator?: boolean };

function applyAddonExclusions(
  input: AddonTarget,
  resolved: ResolvedBrowsingSettingsAddons,
  viewer: Viewer
) {
  input.disablePoi = input.disablePoi || resolved.disablePoi;
  input.disableMinor = input.disableMinor || resolved.disableMinor;

  const isOwnScoped =
    !!(viewer.id && input.userId && viewer.id === input.userId) ||
    !!(
      viewer.username &&
      input.username &&
      input.username.toLowerCase() === viewer.username.toLowerCase()
    );
  if (!isOwnScoped && resolved.excludedTagIds.length) {
    input.excludedTagIds = [
      ...new Set([...(input.excludedTagIds ?? []), ...resolved.excludedTagIds]),
    ];
  }
}

async function loadBlockedBrowsingContext(browsingLevel: number | undefined, viewer: Viewer) {
  const [blocked, addons] = await Promise.all([
    getBlockedBrowsingTags(),
    getBrowsingSettingAddons(),
  ]);
  // `||` (not `??`): a client-sent browsingLevel of 0 would intersect no addon
  // entry and silently disable every exclusion. Same guard for a Blocked-only
  // level collapsing to 0 after onlySelectableLevels.
  const level =
    onlySelectableLevels(browsingLevel || publicBrowsingLevelsFlag) || publicBrowsingLevelsFlag;
  const resolved = resolveBrowsingSettingsAddons(addons, level, {
    isModerator: viewer.isModerator,
  });
  return { blocked, resolved };
}

/**
 * Server-side enforcement of the blocked-browsing-tags policy for an image feed
 * input. Mutates `input` in place and returns `{ emptyResult }`:
 *  - W2: strips blocked tag ids from `input.tags`; signals empty when the
 *    caller's tag filter was entirely blocked (short-circuit to empty page).
 *  - W1: re-derives the browsing-settings addon exclusions server-side and
 *    unions them in. Moderators bypass (resolveBrowsingSettingsAddons); a
 *    viewer's own-content feed keeps its tag exclusions off (own POI stays
 *    visible), matching the client's `isOwnImages` behavior.
 */
export async function enforceBlockedBrowsingTags(
  input: AddonTarget & { tags?: number[] },
  viewer: Viewer
): Promise<{ emptyResult: boolean }> {
  const { blocked, resolved } = await loadBlockedBrowsingContext(input.browsingLevel, viewer);

  const strip = stripBlockedTagIds(
    input.tags,
    blocked.map((t) => t.id)
  );
  if (strip.emptyResult) return { emptyResult: true };
  input.tags = strip.tagIds;

  applyAddonExclusions(input, resolved, viewer);
  return { emptyResult: false };
}

/**
 * Model-feed equivalent of `enforceBlockedBrowsingTags`. Models filter by a
 * single tag name (`tag`/`tagname`) rather than an id array, so W2 short-circuits
 * when that name is blocked.
 */
export async function enforceBlockedBrowsingTagsForModels(
  input: AddonTarget & { tag?: string; tagname?: string },
  viewer: Viewer
): Promise<{ emptyResult: boolean }> {
  const { blocked, resolved } = await loadBlockedBrowsingContext(input.browsingLevel, viewer);

  const requestedTagName = input.tagname ?? input.tag;
  if (
    isBlockedTagName(
      requestedTagName,
      blocked.map((t) => t.name.toLowerCase())
    )
  )
    return { emptyResult: true };

  applyAddonExclusions(input, resolved, viewer);
  return { emptyResult: false };
}

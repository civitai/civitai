import {
  onlySelectableLevels,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { ResolvedBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { getBlockedBrowsingTags, getBrowsingSettingAddons } from '~/server/services/system-cache';
import { isBlockedTagName, stripBlockedTagIds } from '~/server/utils/blocked-browsing-tags';
import { isViewerUsername } from '~/utils/is-viewer';
import type { Context } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import { isWithheldMatureCover } from '~/server/search-index/utils/tagged-mature-image';
import { relatedPostsBrowsingLevel } from '~/server/utils/browsing-level';

type AddonTarget = {
  excludedTagIds?: number[];
  disablePoi?: boolean;
  disableMinor?: boolean;
  userId?: number;
  username?: string;
  browsingLevel?: number;
  newCreators?: boolean;
};

type Viewer = { id?: number; username?: string | null; isModerator?: boolean };

export type EnforcementOptions = {
  /**
   * Drop the addon-derived DISCOVERY exclusions (`disableMinor` + the tag
   * union). The addon rules read `browsingLevel` as viewer intent, which only
   * holds for a feed; a lookup by id passes a permission CEILING
   * (allBrowsingLevelsFlag), so they fire on every such call and 404 content the
   * site itself serves at the same id — `getModel` applies none of this
   * (model.service.ts). `disablePoi` deliberately survives: the model page 404s
   * POI models too, so keeping it is what makes the two paths agree.
   * Caller-set values still stand — this only drops the implicit ones.
   */
  ignoreBrowsingAddons?: boolean;
};

function applyAddonExclusions(
  input: AddonTarget,
  resolved: ResolvedBrowsingSettingsAddons,
  viewer: Viewer,
  opts?: EnforcementOptions
) {
  input.disablePoi = input.disablePoi || resolved.disablePoi;
  if (opts?.ignoreBrowsingAddons) return;

  input.disableMinor = input.disableMinor || resolved.disableMinor;

  // Own-scoped on the identifier the feed FILTERS by: a `userId` whenever present (the feeds read
  // `userId ?? <username lookup>`), so a `userId` naming another creator is their feed whatever
  // `username` says, and the viewer's own `userId` is their feed even beside a username that does
  // not match (the profile media page sends a slugified one). Without a `userId`, the `username`.
  const isOwnScoped = input.userId
    ? !!(viewer.id && viewer.id === input.userId)
    : isViewerUsername(viewer, input.username);
  if (!isOwnScoped && resolved.excludedTagIds.length) {
    input.excludedTagIds = [
      ...new Set([...(input.excludedTagIds ?? []), ...resolved.excludedTagIds]),
    ];
  }
}

async function loadBlockedBrowsingContext(input: AddonTarget, viewer: Viewer) {
  const [blocked, addons] = await Promise.all([
    getBlockedBrowsingTags(),
    getBrowsingSettingAddons(),
  ]);
  // `||` (not `??`): a client-sent browsingLevel of 0 would intersect no addon
  // entry and silently disable every exclusion. Same guard for a Blocked-only
  // level collapsing to 0 after onlySelectableLevels.
  const level =
    onlySelectableLevels(input.browsingLevel || publicBrowsingLevelsFlag) ||
    publicBrowsingLevelsFlag;
  const resolved = resolveBrowsingSettingsAddons(addons, level, {
    isModerator: viewer.isModerator,
    scope: input.newCreators ? 'newCreators' : undefined,
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
 *    visible).
 */
export async function enforceBlockedBrowsingTags(
  input: AddonTarget & { tags?: number[] },
  viewer: Viewer
): Promise<{ emptyResult: boolean }> {
  const { blocked, resolved } = await loadBlockedBrowsingContext(input, viewer);

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
  viewer: Viewer,
  opts?: EnforcementOptions
): Promise<{ emptyResult: boolean }> {
  const { blocked, resolved } = await loadBlockedBrowsingContext(input, viewer);

  const requestedTagName = input.tagname ?? input.tag;
  if (
    isBlockedTagName(
      requestedTagName,
      blocked.map((t) => t.name.toLowerCase())
    )
  )
    return { emptyResult: true };

  applyAddonExclusions(input, resolved, viewer, opts);
  return { emptyResult: false };
}

type ShowcaseImage = {
  userId?: number;
  poi?: boolean | null;
  minor?: boolean | null;
  tags?: number[] | null;
};

/**
 * The browsing-settings exclusions (tags, poi, minor) for a showcase at `browsingLevel`. Resolved onto
 * a target of its own, which names no owner, so none of the tag exclusions are skipped.
 */
export async function resolveShowcaseExclusions({
  browsingLevel,
  viewer = {},
}: {
  browsingLevel?: number;
  viewer?: Viewer;
}) {
  const rules: AddonTarget = { browsingLevel };
  await enforceBlockedBrowsingTagsForModels(rules, viewer);
  return {
    excludedTagIds: rules.excludedTagIds ?? [],
    disablePoi: !!rules.disablePoi,
    disableMinor: !!rules.disableMinor,
  };
}

/**
 * `resolveShowcaseExclusions` as a filter over showcase images. The viewer's own images pass; an
 * image with no tag ids read is hidden while any tag is excluded.
 */
export async function getShowcaseImageFilter({
  browsingLevel,
  viewer = {},
  excludedTagIds,
}: {
  browsingLevel?: number;
  viewer?: Viewer;
  excludedTagIds?: number[];
}) {
  const rules = await resolveShowcaseExclusions({ browsingLevel, viewer });
  const excluded = new Set([...rules.excludedTagIds, ...(excludedTagIds ?? [])]);
  return (image: ShowcaseImage) =>
    (!!viewer.id && image.userId === viewer.id) ||
    (!(rules.disablePoi && image.poi) &&
      !(rules.disableMinor && image.minor) &&
      (!excluded.size || (image.tags != null && !image.tags.some((tagId) => excluded.has(tagId)))));
}

/**
 * `getShowcaseImageFilter` for a listing of other people's images: the request's viewer, at the
 * level `relatedPostsBrowsingLevel` resolves. Takes tags as ids or as `{ id }` rows.
 */
export async function getRequestImageFilter(
  ctx: Pick<Context, 'user' | 'features' | 'req'>,
  requestedBrowsingLevel?: number
) {
  const showsImage = await getShowcaseImageFilter({
    browsingLevel: relatedPostsBrowsingLevel(ctx, requestedBrowsingLevel),
    viewer: { id: ctx.user?.id, username: ctx.user?.username, isModerator: ctx.user?.isModerator },
  });
  // Unread tags stay unread, so `getShowcaseImageFilter` hides the image while any tag is excluded.
  return (image: Omit<ShowcaseImage, 'tags'> & { tags?: (number | { id: number })[] | null }) =>
    showsImage({
      ...image,
      tags: image.tags?.map((tag) => (typeof tag === 'number' ? tag : tag.id)),
    });
}

/** Whether the viewer's browsing-settings rules (tags, POI, minor) let them see this cover. */
export async function isCoverShownByBrowsingRules(
  image: { id: number; userId: number; tags: { tag: { id: number } }[] } | null,
  ctx: Pick<Context, 'user' | 'features' | 'req'>
) {
  if (!image) return true;
  const [showsImage, flags] = await Promise.all([
    getRequestImageFilter(ctx),
    dbRead.image.findUnique({
      where: { id: image.id },
      select: { poi: true, minor: true, nsfwLevel: true },
    }),
  ]);
  // No row means its flags are unread: hidden, as unread tags are.
  if (!flags) return false;
  const tags = image.tags.map(({ tag }) => tag);
  if (isWithheldMatureCover({ nsfwLevel: flags.nsfwLevel, tags: tags.map(({ id }) => id) })) {
    return false;
  }
  return showsImage({ ...image, ...flags, tags });
}

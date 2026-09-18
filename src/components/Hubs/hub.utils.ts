import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import type { HubPanelHub } from '~/components/Hubs/HubSourcePanel';
import { hubLimits, hubSourceKey, hubTagGroupKey } from '~/server/schema/user-hub.schema';
import { Availability, UserHubSourceType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';
import { Flags } from '~/shared/utils/flags';
import { slugit } from '~/utils/string-helpers';

/**
 * The image feed's query key carries `hubId`, not the source list, so it does not
 * refetch on its own when a hub's sources change.
 */
export function useInvalidateHub() {
  const utils = trpc.useUtils();

  return async (hubId: number) => {
    await Promise.all([
      utils.userHub.getAll.invalidate(),
      // Unfiltered: `getById` is now addressed by the hub's encoded KEY, which this
      // caller does not always hold. A viewer has a handful of hubs, so dropping the
      // filter costs a refetch of those and removes a key/id mismatch that would
      // silently invalidate nothing.
      utils.userHub.getById.invalidate(),
      utils.image.getInfinite.invalidate({ hubId }),
    ]);
  };
}

// The id stays canonical and the slug is decoration, the same way articles do it:
// a renamed hub keeps working from every link anyone was already given.
/**
 * `key`, never `id`. The path carries the hub's ENCODED id — an int there makes every
 * public hub walkable by counting, since the page and its preview card both answer
 * unauthenticated. The encoding happens server-side (`~/server/utils/hub-id`) and
 * arrives on the hub, so the client never holds the salt.
 */
export function hubUrl(hub: { key: string; name: string }) {
  const slug = slugit(hub.name);
  return slug ? `/hubs/${hub.key}/${slug}` : `/hubs/${hub.key}`;
}

/**
 * Who may turn sharing ON. The OWNER only — publishing someone's private hub is a
 * different act from editing one, and moderators were granted the second and not the
 * first. Lifted out of the page so that boundary is a testable thing rather than a
 * `&&` in JSX.
 */
export function canPublishHub(hub: { isOwner: boolean; availability: Availability }) {
  return hub.isOwner && hub.availability !== Availability.Public;
}

/**
 * The level the FEED will run at: a viewer's session override if they set one, else
 * their own. The lock-out banner must be computed from THIS and not from the account
 * level, or it claims a lockout over a feed with results.
 */
export function hubEffectiveLevel(sessionLevel: number | undefined, viewerLevel: number) {
  return sessionLevel || viewerLevel;
}

/**
 * Whether this hub's own cap leaves this viewer nothing at all. Lifted out of the
 * page so it can be tested, and so the banner and the feed are computed from the
 * SAME number — they were not, and the banner could claim a lockout over a feed
 * with results.
 */
export function hubLocksViewerOut(forcedBrowsingLevel: number, viewerLevel: number) {
  if (!forcedBrowsingLevel) return false;
  return !Flags.intersects(forcedBrowsingLevel, viewerLevel);
}

/**
 * What "Duplicate this hub" hands the create modal. A point-in-time copy: the new
 * hub carries the sources the original had at this moment and no link back to it,
 * so the original changing later changes nothing here (subtask 868kwp5j3).
 *
 * Only the sources the owner has switched ON are copied — a source switched off
 * contributes nothing to the hub being copied, so copying it would hand the copier
 * a hub that does not match what they were looking at.
 */
export function buildDuplicateHubInput(hub: {
  id?: number;
  name: string;
  forcedBrowsingLevel?: number;
  sources: {
    id?: number;
    type: HubSourceValue['type'];
    targetId: number;
    alias?: string | null;
    enabled: boolean;
    exclude?: boolean;
    groupKey?: number | null;
  }[];
}) {
  return {
    name: `${hub.name} (copy)`.slice(0, hubLimits.nameLength),
    // Carried, because the level is the reason the level exists: the hub Ellie
    // described collects creators whose other work is porn, and a copy without the
    // cap hands the copier that list uncapped. It cannot widen anything — the
    // copier's own level still intersects it.
    forcedBrowsingLevel: hub.forcedBrowsingLevel ?? 0,
    // Fields picked one by one rather than spread: `getById` rows carry a row `id`,
    // and passing one through would address the ORIGINAL's source rows.
    // Sliced per kind, because the two caps are separate: one `slice` over the
    // combined list would let a long source list swallow the copier's exclusions,
    // which is the half that keeps content OUT.
    sources: [
      ...hub.sources
        .filter((source) => source.enabled && !source.exclude)
        .slice(0, hubLimits.sourcesPerHub),
      ...hub.sources
        .filter((source) => source.enabled && source.exclude)
        .slice(0, hubLimits.exclusionsPerHub),
    ].map((source, index) => ({
      type: source.type,
      targetId: source.targetId,
      alias: source.alias ?? null,
      enabled: true,
      exclude: !!source.exclude,
      index,
      // Carried, not renumbered: the keys only have to be distinct within the copy,
      // and dropping them would silently un-group every AND-set the original had.
      groupKey: source.groupKey ?? null,
    })),
  };
}

export type HubSourceGroup = { key: string; sources: HubSourceValue[] };

/**
 * The source list as the cards that render it: tag sources sharing a `groupKey` become
 * ONE card whose tags are ANDed, everything else stays one card per source.
 *
 * Mirrors `groupTagIds` in user-hub.service.ts, which states the same rule over DB
 * rows: tags only, keyed by `hubTagGroupKey`, first-appearance order, a null key
 * meaning a group of one.
 *
 * They are separate for a MECHANICAL reason, not a taste one: this module imports
 * `trpc` (for `useInvalidateHub`), so it is client-only and no server module can ever
 * import from it. The part that genuinely must not diverge is the KEY, and that lives
 * in `user-hub.schema.ts`, which both sides already import. Do not answer a future
 * "why isn't this shared?" with anything else — a reason a reader can disprove invites
 * the refactor it is trying to forestall.
 */
export function groupHubSources(value: HubSourceValue[]): HubSourceGroup[] {
  const groups: HubSourceGroup[] = [];
  const byKey = new Map<string, HubSourceGroup>();
  for (const source of value) {
    if (source.type !== UserHubSourceType.Tag || source.groupKey == null) {
      groups.push({ key: hubSourceKey(source), sources: [source] });
      continue;
    }
    // Prefixed, because these keys share a list with `hubSourceKey` values above.
    const key = `tag-${hubTagGroupKey({ ...source, groupKey: source.groupKey })}`;
    const held = byKey.get(key);
    if (held) {
      held.sources.push(source);
      continue;
    }
    const group = { key, sources: [source] };
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}

/**
 * The lowest key no source is using, over the WHOLE list rather than one polarity —
 * an include group and an exclude group can then never be handed the same number,
 * even though the resolver keeps them apart anyway.
 *
 * Lowest-free rather than max-plus-one so the key is bounded by the number of rows a
 * hub may hold. `userHubSourceSchema` caps `groupKey` at that bound, and max-plus-one
 * can climb past it across enough edits — which would refuse a save the owner has no
 * way to fix, for a key that only has to be locally distinct.
 */
export function nextHubGroupKey(value: { groupKey?: number | null }[]) {
  const used = new Set(value.map((source) => source.groupKey).filter((key) => key != null));
  let key = 0;
  while (used.has(key)) key += 1;
  return key;
}

/**
 * The group's membership set. Exported because the picker's `isAdded` asks the same
 * question the transforms below do, and membership is NOT row identity forever — the
 * whole point of `groupKey` is that it is a separate axis. Two copies would part the
 * day anyone makes it key-aware, and the picker would then grey out a tag the
 * transform would happily move, with no error path.
 */
export const groupMemberKeys = (group: HubSourceGroup) => new Set(group.sources.map(hubSourceKey));

/**
 * The row a hub already holds for this target, if any. One spelling, because the
 * caller decides refuse-vs-proceed from it and `addTagToHubGroup` decides
 * move-vs-append from it, on the same click — and a pair that disagrees mutates a row
 * the caller believed it had refused.
 */
export function findHubSource(
  value: HubSourceValue[],
  target: { type: UserHubSourceType; targetId: number }
) {
  const key = hubSourceKey(target);
  return value.find((source) => hubSourceKey(source) === key);
}

/**
 * 🔴 The two halves of a group mean OPPOSITE things, and this wording is the only
 * place in the product that says so. Grouping tags you WANT narrows the feed; grouping
 * tags you want GONE removes LESS, because `NOT (x AND y)` keeps an image carrying only
 * x. Justin approved the asymmetry on 2026-09-17 — if the copy changes, keep it.
 *
 * Here rather than in `HubSourceCard` so the pin in `hub-groups.test.ts` does not drag
 * a Mantine component's whole import graph into a pure unit test to read one string.
 */
export const groupRule = (exclude?: boolean) =>
  exclude ? 'Only block when all of these match' : 'Require all of these';

/**
 * Put a tag into a group, minting the group's key on the click that creates it.
 *
 * A tag the hub ALREADY holds on this side of `exclude` is MOVED in rather than added
 * again: the row's unique `(hubId, type, targetId)` means there is only ever one of
 * it, so re-adding is impossible and refusing left the owner with no way to group two
 * tags they already had. A move spends no cap, because it adds no row — the CALLER
 * owns the cap check, since only it can tell the user why an add was refused.
 *
 * 🔴 A CROSS-POLARITY target returns `value` untouched. The caller refuses it too and
 * shows the message; this is the half that has a test. Without it, deleting the
 * caller's one-line check moves a kept-out tag into an include group — and because the
 * move branch does not rewrite `exclude`, the row keeps `exclude: true` while taking
 * the include group's key, landing it in the server's exclude bucket and merging it
 * into an unrelated AND-set. `NOT (a AND b)` removes strictly less than `NOT a OR
 * NOT b`, so an exclusion the owner set quietly stops excluding.
 */
export function addTagToHubGroup(
  value: HubSourceValue[],
  group: HubSourceGroup,
  item: { targetId: number; alias: string }
): HubSourceValue[] {
  const first = group.sources[0];
  const target = { type: UserHubSourceType.Tag, targetId: item.targetId };
  const held = findHubSource(value, target);
  if (held && !!held.exclude !== !!first.exclude) return value;

  const groupKey = first.groupKey ?? nextHubGroupKey(value);
  const members = groupMemberKeys(group);
  const targetKey = hubSourceKey(target);

  const next = value.map((source) => {
    const key = hubSourceKey(source);
    // A MOVED row inherits `enabled` so the group stays switchable as one unit. It
    // keeps its own `exclude`, `alias` and `index`, which the refusal above is what
    // makes safe.
    if (key === targetKey) return { ...source, groupKey, enabled: first.enabled };
    return members.has(key) ? { ...source, groupKey } : source;
  });
  if (held) return next;

  return [
    ...next,
    {
      ...target,
      alias: item.alias.trim().slice(0, hubLimits.aliasLength),
      // Both inherited from the group, not defaulted. `exclude` is the sharp one: a
      // default would land a tag added to a KEPT-OUT group on the include side, so a
      // click meaning "block more" would surface content instead. `enabled` keeps the
      // card from reading as off while one member still filters.
      enabled: first.enabled,
      exclude: !!first.exclude,
      index: value.length,
      groupKey,
    },
  ];
}

/**
 * Remove one tag from the hub, leaving the rest of its group intact.
 *
 * It DELETES the row rather than clearing `groupKey`. That was tried the other way —
 * ungrouping, so a tag pulled into a group could be pulled back out without losing it
 * — and Justin called it weird on sight (2026-09-18): a ✕ on a chip reads as "get rid
 * of this", and leaving the tag behind as a new card looks like the click did
 * something else. The label says "from this hub" so the control and the copy agree.
 *
 * The cost, accepted knowingly: moving a tag the hub already had into a group has no
 * one-click undo — you re-add it. Revisit by adding a separate ungroup affordance, not
 * by overloading this one again.
 */
export function removeHubTag(value: HubSourceValue[], targetId: number) {
  const targetKey = hubSourceKey({ type: UserHubSourceType.Tag, targetId });
  return value.filter((source) => hubSourceKey(source) !== targetKey);
}

/** Drop every member of a group. What the card's trash button means. */
export function removeHubGroup(value: HubSourceValue[], group: HubSourceGroup) {
  const members = groupMemberKeys(group);
  return value.filter((source) => !members.has(hubSourceKey(source)));
}

/**
 * Switch a whole group at once. A half-enabled AND-set filters on fewer tags than the
 * card shows, with nothing on screen saying which.
 */
export function setHubGroupEnabled(
  value: HubSourceValue[],
  group: HubSourceGroup,
  enabled: boolean
) {
  const members = groupMemberKeys(group);
  return value.map((source) =>
    members.has(hubSourceKey(source)) ? { ...source, enabled } : source
  );
}

// The rail and the sub-nav popover both render the panel from a `getById` row, so
// the one mapping between them lives here.
export function toPanelHub(hub: {
  id: number;
  name: string;
  forcedBrowsingLevel: number;
  availability: Availability;
  isOwner: boolean;
  sources: {
    id: number;
    type: HubPanelHub['sources'][number]['type'];
    targetId: number;
    alias: string | null;
    enabled: boolean;
    exclude: boolean;
    index: number;
    groupKey: number | null;
  }[];
  excludedCount: number;
}): HubPanelHub {
  return {
    id: hub.id,
    name: hub.name,
    forcedBrowsingLevel: hub.forcedBrowsingLevel,
    availability: hub.availability,
    isOwner: hub.isOwner,
    sources: hub.sources.map(({ id: _id, ...source }) => source),
    excludedCount: hub.excludedCount,
  };
}

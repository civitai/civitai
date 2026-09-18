import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import type { HubPanelHub } from '~/components/Hubs/HubSourcePanel';
import { hubLimits } from '~/server/schema/user-hub.schema';
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
 * Mirrors `groupTagIds` in user-hub.service.ts, including the polarity scoping — an
 * include group 3 and an exclude group 3 are different groups. The two cannot share
 * code (one holds rows, the other display values), so a change to either rule belongs
 * in both.
 */
export function groupHubSources(value: HubSourceValue[]): HubSourceGroup[] {
  const groups: HubSourceGroup[] = [];
  const byKey = new Map<string, HubSourceGroup>();
  for (const source of value) {
    if (source.type !== UserHubSourceType.Tag || source.groupKey == null) {
      groups.push({ key: `${source.type}-${source.targetId}`, sources: [source] });
      continue;
    }
    const key = `tag-${source.exclude ? 'x' : 'i'}-${source.groupKey}`;
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
 * The next free group key for a hub. Taken from the whole list rather than one
 * polarity, so an include group and an exclude group can never be handed the same
 * number even though the resolver would keep them apart anyway.
 */
export function nextHubGroupKey(value: { groupKey?: number | null }[]) {
  return value.reduce((max, source) => Math.max(max, source.groupKey ?? -1), -1) + 1;
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

import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import { hubLimits } from '~/server/schema/user-hub.schema';
import { Availability } from '~/shared/utils/prisma/enums';
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
 * Where /hubs sends someone who owns more than one: the hub they last opened.
 *
 * A cookie rather than a stored setting, because this is a navigation convenience,
 * not a preference — it costs no write per hub view, and `/hubs` can read it in SSR
 * with no query at all. Per browser is the right grain for "where I was"; a new
 * device simply gets the page instead.
 *
 * The value is a hub KEY, and it is only ever trusted after being matched against
 * the hubs the viewer actually owns — a stale key is a hub that was deleted, or one
 * someone else's cookie named.
 */
export const LAST_HUB_COOKIE = 'hub-last-viewed';

const sourceKindLabels: Record<string, string> = {
  User: 'Creator',
  Model: 'Model',
  ModelVersion: 'Version',
  Collection: 'Collection',
  Tag: 'Tag',
};

/** What a source is called in front of a person: "Creator", not `User`. */
export function hubSourceKindLabel(type: string) {
  return sourceKindLabels[type] ?? 'Source';
}

const sourceNouns: Record<string, [string, string]> = {
  User: ['creator', 'creators'],
  Model: ['model', 'models'],
  ModelVersion: ['version', 'versions'],
  Collection: ['collection', 'collections'],
  Tag: ['tag', 'tags'],
};

/**
 * What a hub holds, for a card that shows no sources: "12 creators, 4 models". Counts
 * only what fills the feed — a switched-off source contributes nothing, and the
 * exclusions are the owner's keep-out list, which is never published as a number
 * beside the things they collect.
 */
export function describeHubSources(
  sources: { type: string; enabled: boolean; exclude: boolean }[]
) {
  const counts = new Map<string, number>();
  for (const source of sources) {
    if (!source.enabled || source.exclude) continue;
    counts.set(source.type, (counts.get(source.type) ?? 0) + 1);
  }

  const parts = [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([type, count]) => {
      const [singular, plural] = sourceNouns[type] ?? ['source', 'sources'];
      return `${count} ${count === 1 ? singular : plural}`;
    });

  return parts.length ? parts.join(', ') : 'Nothing in it yet';
}

/**
 * A `getById` row's sources as the editor takes them. The row `id` is dropped: it
 * addresses the STORED row, and the list the modal saves replaces those rows
 * wholesale — carrying it back would name rows the write has already deleted.
 */
export function toEditorSources(
  sources: {
    id: number;
    type: HubSourceValue['type'];
    targetId: number;
    alias: string | null;
    enabled: boolean;
    exclude: boolean;
    index: number;
  }[]
): HubSourceValue[] {
  return sources.map(({ id: _id, ...source }) => source);
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
    })),
  };
}

import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import type { HubPanelHub } from '~/components/Hubs/HubSourcePanel';
import { hubLimits } from '~/server/schema/user-hub.schema';
import type { Availability } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';
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
      utils.userHub.getById.invalidate({ id: hubId }),
      utils.image.getInfinite.invalidate({ hubId }),
    ]);
  };
}

// The id stays canonical and the slug is decoration, the same way articles do it:
// a renamed hub keeps working from every link anyone was already given.
export function hubUrl(hub: { id: number; name: string }) {
  const slug = slugit(hub.name);
  return slug ? `/hubs/${hub.id}/${slug}` : `/hubs/${hub.id}`;
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
    sources: hub.sources
      .filter((source) => source.enabled)
      .slice(0, hubLimits.sourcesPerHub)
      .map((source, index) => ({
        type: source.type,
        targetId: source.targetId,
        alias: source.alias ?? null,
        enabled: true,
        index,
      })),
  };
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
    index: number;
  }[];
}): HubPanelHub {
  return {
    id: hub.id,
    name: hub.name,
    forcedBrowsingLevel: hub.forcedBrowsingLevel,
    availability: hub.availability,
    isOwner: hub.isOwner,
    sources: hub.sources.map(({ id: _id, ...source }) => source),
  };
}

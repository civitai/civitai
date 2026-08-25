import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import type { HubPanelHub } from '~/components/Hubs/HubSourcePanel';
import { hubLimits } from '~/server/schema/user-hub.schema';
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
  name: string;
  sources: {
    type: HubSourceValue['type'];
    targetId: number;
    alias?: string | null;
    enabled: boolean;
  }[];
}) {
  return {
    name: `${hub.name} (copy)`.slice(0, hubLimits.nameLength),
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
  nsfwLevel: number;
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
    nsfwLevel: hub.nsfwLevel,
    isOwner: hub.isOwner,
    sources: hub.sources.map(({ id: _id, ...source }) => source),
  };
}

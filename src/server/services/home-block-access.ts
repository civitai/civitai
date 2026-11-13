import type { EventViewer, GatedEvent } from '~/server/events/event-access';
import { canReadEvent, getEventAccess, isFlagOnFor } from '~/server/events/event-access';
import { loadEvents } from '~/server/events/load-events';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import type { FeatureFlagKey } from '~/server/services/feature-flags.service';
import { featureFlagKeys, getFeatureFliptKey } from '~/server/services/feature-flags.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

/** Rows must carry RESOLVED metadata: a clone's own column is empty and its source's flag gates it. */
type GateableHomeBlock = { type: HomeBlockType; metadata: unknown };

type GateOptions = { now?: Date; eventDefs?: readonly GatedEvent[] };

const fliptKeyOfHomeBlockFlag = (flag: unknown) =>
  typeof flag === 'string' && featureFlagKeys.includes(flag as FeatureFlagKey)
    ? getFeatureFliptKey(flag as FeatureFlagKey)
    : undefined;

export function assertValidHomeBlockFeatureFlag(metadata: unknown) {
  const flag = (metadata as HomeBlockMetaSchema | undefined)?.featureFlag;
  if (flag !== undefined && !fliptKeyOfHomeBlockFlag(flag))
    throw throwBadRequestError(
      `featureFlag "${String(flag)}" is not a feature flag with a Flipt key`
    );
}

/** Gated rows answer differently per viewer, so they must never be served from a shared cache. */
export function isHomeBlockGated(homeBlock: GateableHomeBlock) {
  const meta = (homeBlock.metadata ?? {}) as HomeBlockMetaSchema;
  return meta.featureFlag !== undefined || homeBlock.type === HomeBlockType.Event;
}

/**
 * An Event row also needs the event's own access, not only its flag: arming the launch turns the
 * flag's base on hours before the start, and the flag stays on after the end.
 */
export async function canViewHomeBlock(
  homeBlock: GateableHomeBlock,
  viewer: EventViewer,
  { now = new Date(), eventDefs }: GateOptions = {}
): Promise<boolean> {
  if (!isHomeBlockGated(homeBlock)) return true;
  const meta = (homeBlock.metadata ?? {}) as HomeBlockMetaSchema;
  try {
    if (meta.featureFlag !== undefined) {
      const fliptKey = fliptKeyOfHomeBlockFlag(meta.featureFlag);
      if (!fliptKey || !(await isFlagOnFor(fliptKey, viewer))) return false;
    }
    if (homeBlock.type === HomeBlockType.Event) {
      const defs = eventDefs ?? (await loadEvents());
      const event = defs.find((e) => e.name === meta.event);
      if (!event || !canReadEvent(await getEventAccess(event, viewer, now))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function filterViewableHomeBlocks<T extends GateableHomeBlock>(
  homeBlocks: T[],
  viewer: EventViewer,
  opts?: GateOptions
): Promise<T[]> {
  const viewable = await Promise.all(homeBlocks.map((b) => canViewHomeBlock(b, viewer, opts)));
  return homeBlocks.filter((_, i) => viewable[i]);
}

// Where a `getHomeBlockById` call was answered (`~/server/services/home-block.service`), by block type
// and by whether the viewer is signed in. Imported from `@civitai/telemetry/client` directly, like
// `home-block-l1.metrics.ts`, so the cache does not pull `~/server/prom/client`'s pool gauges into
// every module that reads it.
//
// Every call is counted exactly once, under one tier, so the tiers of a type sum to its calls:
//   l1            served from this process's copy of the shared entry (`home-block-server-cache`)
//   redis         served from the shared Redis entry
//   miss          built from source (the shared entry was absent or unreadable)
//   uncached      a collection shown to this viewer only: built from source, never cached
//   no_identifier the row resolves to no cache identifier, so nothing is served (answers null)
//   denied        the viewer may not see the block (a gate, or the collection's audience)
//   not_found     no such row (type `none`, since there is no row to read it from)
//   error         the call threw
//
// Cardinality is bounded by the code: `type` is a HomeBlockType value (anything else is `other`),
// `tier` and `viewer` are the literals below. No id, user or domain is ever a label.
import { registerCounterWithLabels } from '@civitai/telemetry/client';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

export type HomeBlockGetTier =
  | 'l1'
  | 'redis'
  | 'miss'
  | 'uncached'
  | 'no_identifier'
  | 'denied'
  | 'not_found'
  | 'error';

/** The tiers `getHomeBlockCached` answers from; the rest are decided before it is reached. */
export type HomeBlockCacheTier = Extract<
  HomeBlockGetTier,
  'l1' | 'redis' | 'miss' | 'no_identifier'
>;

export const homeBlockGetCounter = registerCounterWithLabels({
  name: 'home_block_get_total',
  help: 'getHomeBlockById calls by block type, where they were answered (l1|redis|miss|uncached|no_identifier|denied|not_found|error) and viewer (anon|authed)',
  labelNames: ['type', 'tier', 'viewer'] as const,
});

const KNOWN_TYPES = new Set<string>(Object.values(HomeBlockType));

/** The `type` label: a HomeBlockType value, `none` when there is no row, `other` for anything else. */
export function homeBlockTypeLabel(type: string | null | undefined) {
  if (type === undefined || type === null) return 'none';
  return KNOWN_TYPES.has(type) ? type : 'other';
}

export function countHomeBlockGet({
  type,
  tier,
  viewer,
}: {
  type: string | null | undefined;
  tier: HomeBlockGetTier;
  viewer: { id?: number } | null | undefined;
}) {
  homeBlockGetCounter.inc({
    type: homeBlockTypeLabel(type),
    tier,
    viewer: viewer?.id ? 'authed' : 'anon',
  });
}

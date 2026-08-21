/**
 * One key per control in the media filter dropdown, so a caller that cannot honour
 * a control can drop it by name — rendering a control that silently does nothing
 * is worse than not offering it.
 *
 * Deliberately a plain module with no imports: it is read by a convention guard in
 * the unit suite, and importing it from the component would drag Mantine, the
 * router and the trpc client into that suite's graph.
 */
export const mediaFilterKeys = [
  'period',
  'types',
  'includePG13',
  'withMeta',
  'requiringMeta',
  'hidden',
  'fromPlatform',
  'scheduled',
  'remixesOnly',
  'nonRemixesOnly',
  'hideChallenges',
  'hideManualResources',
  'hideAutoResources',
  'poiOnly',
  'minorOnly',
  'disablePoi',
  'disableMinor',
  'notPublished',
  'baseModels',
  'tools',
  'techniques',
] as const;

export type MediaFilterKey = (typeof mediaFilterKeys)[number];

/**
 * Controls a hub cannot keep. A hub's filters persist on its row, and these are
 * per-session states — a hidden-images view, your own unpublished or scheduled
 * posts — or moderation tooling. None of them describe the hub, so a control that
 * forgets itself on reload is worse than no control.
 *
 * `hub-filter-parity.test.ts` asserts everything NOT listed here is persistable.
 */
export const hubExcludedFilterKeys: MediaFilterKey[] = [
  'hidden',
  // Only render for filterType 'modelImages', so they withhold nothing from a hub
  // today — listed because a hub cannot persist them either.
  'hideManualResources',
  'hideAutoResources',
  'scheduled',
  'notPublished',
  'requiringMeta',
  'poiOnly',
  'minorOnly',
  'disablePoi',
  'disableMinor',
];

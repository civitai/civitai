import type {
  NavGateContext,
  NavPlacement,
  NavRegistryEntry,
} from '~/components/HomeContentToggle/nav-registry';
import type { NavKey } from '~/shared/constants/nav.constants';

export type NavConfig = {
  bar: NavKey[];
  more: NavKey[];
  hidden: NavKey[];
  showLabels?: boolean;
};

/**
 * The two retired flags, read from the RAW `User.settings.features` blob — never from resolved
 * `FeatureAccess`. Once `postsNavItem` stops being `toggleable`, `computeUserFeatureFlagsOverlay`
 * filters the user's stored value out of the resolved flags, so seeding from those would hide
 * Posts from exactly the users who turned it on.
 */
export type NavSeedFlags = {
  postsNavItem?: boolean;
  eventsNavItem?: boolean;
};

export type ResolvedNav = {
  bar: NavRegistryEntry[];
  more: NavRegistryEntry[];
  showLabels: boolean;
};

const PLACED_ZONES = ['bar', 'more', 'hidden'] as const;

/**
 * `hidden` here is the USER'S placement. An item the viewer has no access to is a separate
 * concept — it is dropped by the gate pass at the end, whatever zone it sits in.
 */
function seedPlacement(entry: NavRegistryEntry, seedFlags: NavSeedFlags | undefined): NavPlacement {
  if (!seedFlags) return entry.defaultPlacement;
  if (entry.key === 'posts' && seedFlags.postsNavItem) return 'bar';
  if (entry.key === 'events' && seedFlags.eventsNavItem) return 'bar';
  return entry.defaultPlacement;
}

/**
 * Merges a user's saved nav config with the registry.
 *
 * A newly-shipped nav item must reach everyone without a backfill, so an item absent from the
 * config is anchored beside the registry neighbours the user actually placed rather than appended.
 * Anchoring is scoped to the TARGET ZONE: "insert after the preceding sibling" names no position
 * when that sibling lives in a different zone, which is the common case the day a `bar`-default
 * item ships under an anchor the user moved to `more`.
 *
 * A config of `{ bar: [], more: [], hidden: [] }` means the user hid everything and is NOT the
 * same as no config — resetting to defaults deletes the key rather than writing empty arrays.
 */
export function resolveNavItems(
  registry: NavRegistryEntry[],
  ctx: NavGateContext,
  config?: NavConfig,
  seedFlags?: NavSeedFlags
): ResolvedNav {
  const byKey = new Map(registry.map((entry) => [entry.key, entry]));
  const zones: Record<(typeof PLACED_ZONES)[number], NavKey[]> = { bar: [], more: [], hidden: [] };
  const zoneOf = new Map<NavKey, NavPlacement>();

  if (config) {
    for (const zone of PLACED_ZONES) {
      for (const key of config[zone]) {
        // Drops keys the registry no longer has, and a key repeated across zones.
        if (!byKey.has(key) || zoneOf.has(key)) continue;
        zones[zone].push(key);
        zoneOf.set(key, zone);
      }
    }
  }

  for (let i = 0; i < registry.length; i++) {
    const entry = registry[i];
    if (zoneOf.has(entry.key)) continue;

    // Per KEY, not per config object. A user who saved a config before this item existed still
    // gets the seed for it; keying the seed on "no config at all" loses Posts permanently for
    // anyone who had the flag on and then saved anything.
    const zone = seedPlacement(entry, seedFlags);
    const target = zones[zone];

    let index = -1;
    for (let before = i - 1; before >= 0 && index === -1; before--) {
      const at = target.indexOf(registry[before].key);
      if (at !== -1) index = at + 1;
    }
    for (let after = i + 1; after < registry.length && index === -1; after++) {
      const at = target.indexOf(registry[after].key);
      if (at !== -1) index = at;
    }
    if (index === -1) index = target.length;

    target.splice(index, 0, entry.key);
    zoneOf.set(entry.key, zone);
  }

  // Gates run LAST, over both visible zones alike, so an item the user pinned but has since lost
  // access to is dropped whatever the config says.
  const resolve = (keys: NavKey[]) =>
    keys
      .map((key) => byKey.get(key))
      .filter((entry): entry is NavRegistryEntry => !!entry && (entry.visible?.(ctx) ?? true));

  return {
    bar: resolve(zones.bar),
    more: resolve(zones.more),
    showLabels: config?.showLabels ?? true,
  };
}

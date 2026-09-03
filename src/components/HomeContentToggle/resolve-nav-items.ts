import type {
  NavGateContext,
  NavGroup,
  NavRegistryEntry,
} from '~/components/HomeContentToggle/nav-registry';
import type { NavKey } from '~/shared/constants/nav.constants';

/**
 * `bar` and `more` are GROUP MEMBERSHIP plus order — every item belongs to exactly one. `hidden`
 * is visibility, and is orthogonal: an item switched off keeps its place in whichever group it
 * sits in, so turning it back on puts it where the user left it rather than at the end.
 */
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

export type NavLayout = {
  groups: Record<NavGroup, NavKey[]>;
  hidden: Set<NavKey>;
};

export type ResolvedNav = {
  bar: NavRegistryEntry[];
  more: NavRegistryEntry[];
  showLabels: boolean;
};

const GROUPS = ['bar', 'more'] as const;

function seedHidden(entry: NavRegistryEntry, seedFlags: NavSeedFlags | undefined): boolean {
  if (entry.key === 'posts') return !seedFlags?.postsNavItem;
  if (entry.key === 'events') return !seedFlags?.eventsNavItem;
  return !!entry.defaultHidden;
}

/**
 * The merge: a user's saved groups, with every registry item they have never placed folded in
 * beside its neighbours.
 *
 * 🔴 This is the ONE implementation. The nav reads it through `resolveNavItems`; the settings
 * modal reads it directly. What the modal shows, what its Save writes, and what the nav renders
 * therefore cannot disagree — which they did in the first cut of this feature, where the modal
 * carried its own merge that skipped the seed, so a user with Posts in their bar saw it as Hidden
 * and lost it on their next save. The same defect is live today in `creatorShop.sections`, whose
 * writer adopts new keys while `StorefrontSections` reads the saved array verbatim.
 *
 * A newly-shipped nav item must reach everyone without a backfill, so an item absent from the
 * config is anchored beside the registry neighbours the user placed rather than appended.
 * Anchoring is scoped to the TARGET GROUP: "insert after the preceding sibling" names no position
 * when that sibling lives in the other group, which is the common case the day a `bar`-default
 * item ships under an anchor the user moved to `more`.
 */
export function resolveNavLayout(
  registry: NavRegistryEntry[],
  config?: NavConfig,
  seedFlags?: NavSeedFlags
): NavLayout {
  const byKey = new Map(registry.map((entry) => [entry.key, entry]));
  const groups: Record<NavGroup, NavKey[]> = { bar: [], more: [] };
  const groupOf = new Map<NavKey, NavGroup>();
  const hidden = new Set<NavKey>();

  if (config) {
    for (const group of GROUPS) {
      for (const key of config[group]) {
        const entry = byKey.get(key);
        // Drops keys the registry no longer has, a key repeated across groups, and any attempt to
        // move a locked item — which is placed from the registry below, not from the config.
        if (!entry || entry.locked || groupOf.has(key)) continue;
        groups[group].push(key);
        groupOf.set(key, group);
      }
    }
    for (const key of config.hidden) {
      const entry = byKey.get(key);
      if (entry && !entry.locked) hidden.add(key);
    }
  }

  for (let i = 0; i < registry.length; i++) {
    const entry = registry[i];
    if (groupOf.has(entry.key)) continue;

    // Per KEY, not per config object. A user who saved a config before this item existed still
    // gets the seed for it; keying the seed on "no config at all" loses Posts permanently for
    // anyone who had the flag on and then saved anything.
    const group = entry.defaultGroup;
    const target = groups[group];

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
    groupOf.set(entry.key, group);
    // Only unplaced items reach here, so their visibility is seeded rather than read from the
    // config — which is what carries a newly-shipped `defaultHidden` item, and what carries
    // posts/events for a user whose retired account switch had them on.
    if (!entry.locked && seedHidden(entry, seedFlags)) hidden.add(entry.key);
  }

  return { groups, hidden };
}

/**
 * The nav's view: the two groups, minus what the user switched off and minus what the viewer
 * cannot reach.
 *
 * Gates run LAST, over both groups alike, so an item the user pinned but has since lost access to
 * is dropped whatever the config says — and a gated item still occupies its slot while anchoring,
 * so it can anchor a neighbour before it disappears.
 */
export function resolveNavItems(
  registry: NavRegistryEntry[],
  ctx: NavGateContext,
  config?: NavConfig,
  seedFlags?: NavSeedFlags
): ResolvedNav {
  const byKey = new Map(registry.map((entry) => [entry.key, entry]));
  const { groups, hidden } = resolveNavLayout(registry, config, seedFlags);

  const resolve = (keys: NavKey[]) =>
    keys
      .filter((key) => !hidden.has(key))
      .map((key) => byKey.get(key))
      .filter((entry): entry is NavRegistryEntry => !!entry && (entry.visible?.(ctx) ?? true));

  return {
    bar: resolve(groups.bar),
    more: resolve(groups.more),
    showLabels: config?.showLabels ?? true,
  };
}

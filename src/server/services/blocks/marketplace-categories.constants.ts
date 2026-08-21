/**
 * F-E E3 — marketplace category taxonomy.
 *
 * SINGLE SOURCE OF TRUTH for the App Blocks marketplace category set. Reused by:
 *   - the `category?` filter validation on `listAvailableSchema`
 *     (`src/server/schema/blocks/subscription.schema.ts`),
 *   - the category selector + chip on the marketplace UI
 *     (`src/pages/apps/index.tsx`, `src/components/Apps/AppBlockCard.tsx`),
 *   - (E4) the mod-set `category` control in the review/approve flow.
 *
 * Stored in the FREE-TEXT `app_blocks.category` column (NOT a Postgres enum), so
 * adding a category is a ONE-LINE edit here with NO migration. The column is
 * NULL until the E3 migration is applied AND a mod assigns one (decisions #1/#4
 * in claudedocs/app-platform-fe-marketplace-plan-2026-06-14.md); the filter is a
 * no-op (every row null) until then — fine while the surface is dark.
 */
export const MARKETPLACE_CATEGORIES = [
  'generation',
  'games',
  'utility',
  'discovery',
  'moderation',
  'analytics',
  'other',
] as const;

export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

/** Human display labels for each category (UI selector + card chip). */
export const MARKETPLACE_CATEGORY_LABELS: Record<MarketplaceCategory, string> = {
  generation: 'Generation',
  games: 'Games',
  utility: 'Utility',
  discovery: 'Discovery',
  moderation: 'Moderation',
  analytics: 'Analytics',
  other: 'Other',
};

/** Type guard — is the given string one of the known marketplace categories. */
export function isMarketplaceCategory(value: unknown): value is MarketplaceCategory {
  return typeof value === 'string' && (MARKETPLACE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Stored category value → its DISPLAY label, with a raw fallback.
 *
 * 🔴 THE ONE PLACE this rule lives. `app_blocks.category` / `app_listings.category`
 * is a FREE-TEXT column, so the value a surface receives is a `string`, not the
 * `MarketplaceCategory` union — every renderer therefore needs the same
 * guard-then-map-else-raw shape, and this is it.
 *
 * It exists because the rule was open-coded instead: two byte-identical private
 * `categoryLabel` helpers (`AppBlockCard`, `RelatedListings`), one title-casing
 * re-derivation (`offsiteSubmitFormConfig`'s `OFFSITE_CATEGORY_OPTIONS`), and five
 * sites that skipped it entirely and rendered the raw lowercase enum to a user.
 * A predicate open-coded at N sites is wrong at N−1 of them; import this instead
 * of writing the guard again.
 *
 * FALLBACK IS DELIBERATE — an unknown/legacy value renders RAW, never blank and
 * never a throw. Adding a category is a one-line const edit with no migration, so
 * an older client will meet a category it has no label for; a chip reading
 * `something-new` is honest, an empty chip is a bug report.
 */
export function marketplaceCategoryLabel(category: string): string {
  return isMarketplaceCategory(category) ? MARKETPLACE_CATEGORY_LABELS[category] : category;
}

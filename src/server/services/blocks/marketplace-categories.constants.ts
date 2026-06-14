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
  return (
    typeof value === 'string' &&
    (MARKETPLACE_CATEGORIES as readonly string[]).includes(value)
  );
}

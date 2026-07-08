/**
 * LCP (largest-contentful-paint) image prioritisation for the homepage home blocks.
 *
 * Production Faro RUM shows the homepage LCP element is the first home block's
 * card image (`AspectRatioImageCard image`) and that its dominant LCP phase is
 * `resource_load_delay` (~2.3s): the feed is client-rendered so the browser's
 * preload scanner can't find the image in the initial HTML, and the plain `<img>`
 * carries no `fetchpriority`. Marking the first above-the-fold cards with
 * `fetchpriority="high"` + `loading="eager"` lets the LCP image jump ahead of the
 * many sibling card images it otherwise contends with once it's in the DOM.
 *
 * IMPORTANT (honest scope): this only addresses the POST-render contention slice —
 * once the image element exists, it stops waiting behind sibling requests. It does
 * NOT address the PRE-render discovery delay (JS download → hydrate → tRPC feed
 * fetch → render), which is the majority of the 2.3s and would require SSR-ing the
 * first image URL / a server-emitted `<link rel="preload">` — deliberately out of
 * scope here (that path was previously reverted).
 */

/**
 * How many leading cards of the first home block to mark high-priority. Kept small
 * on purpose: on mobile (1-column reflow) the LCP is the single first card; on
 * desktop the first row is above the fold. Prioritising everything is priority on
 * nothing, so cap at the leading cards that plausibly hold the LCP element.
 */
export const LCP_PRIORITY_ITEM_COUNT = 4;

/**
 * Decide whether a given home-block card should be fetched at high priority.
 * Gated on the feature flag, on being the first (top) home block, and on the
 * card being one of the first `LCP_PRIORITY_ITEM_COUNT` items in that block.
 */
export function shouldPrioritizeLcpImage({
  enabled,
  isFirstBlock,
  index,
  count = LCP_PRIORITY_ITEM_COUNT,
}: {
  enabled: boolean;
  isFirstBlock: boolean;
  index: number;
  count?: number;
}): boolean {
  return enabled && isFirstBlock && index >= 0 && index < count;
}

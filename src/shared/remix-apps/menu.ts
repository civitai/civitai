import { readRemixTag, REMIX_APP_TAG } from '~/shared/remix-apps/tags';

/** App rows the Remix menu shows; "See more" lists them all. */
export const REMIX_MENU_ROWS = 5;

/** The most apps a viewer can pin; settings ride every signed-in render, so it stays bounded. */
export const REMIX_PINS_MAX = 24;

/**
 * The menu's apps: pinned first, in pin order, topped up with recently used ones, then the rest
 * in registry order. `apps` is already what this viewer may run on this image, so a pinned or
 * recent slug that is disabled, unknown or inapplicable here is skipped, not removed.
 */
export function orderRemixMenuApps<T extends { slug: string }>({
  apps,
  pinned,
  recent,
  rows = REMIX_MENU_ROWS,
}: {
  apps: readonly T[];
  pinned: readonly string[];
  recent: readonly string[];
  rows?: number;
}) {
  const bySlug = new Map(apps.map((app) => [app.slug, app]));
  const ordered = new Map<string, T>();
  for (const slug of [...pinned, ...recent, ...bySlug.keys()]) {
    const app = bySlug.get(slug);
    if (app && !ordered.has(slug)) ordered.set(slug, app);
  }
  return [...ordered.values()].slice(0, rows);
}

/** Distinct app slugs from the viewer's remix workflows, newest first, as the queue lists them. */
export function recentRemixAppSlugs(workflows: readonly { tags?: string[] | null }[]) {
  const slugs = new Set<string>();
  for (const workflow of workflows) {
    const slug = readRemixTag(workflow.tags ?? undefined, `${REMIX_APP_TAG}:`);
    if (slug) slugs.add(slug);
  }
  return [...slugs];
}

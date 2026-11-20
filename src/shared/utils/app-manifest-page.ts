/**
 * W10 — does the manifest declare a full-page surface? A page app carries a
 * `page: { path, title, icon? }` object (validated at registration time). Used
 * to gate the page-mint + SSR resolve so a region/model-only app can't be
 * opened as a full page, and by the approval notification, which links to the
 * run page only for an app that has one.
 */
export function manifestDeclaresPage(manifest: unknown): boolean {
  const m = (manifest ?? {}) as { page?: unknown };
  if (!m.page || typeof m.page !== 'object') return false;
  const page = m.page as { path?: unknown };
  return typeof page.path === 'string' && page.path.length > 0;
}

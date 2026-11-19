/**
 * The listing ids of `rows`, in the order `slugs` names them: how a search answered elsewhere
 * (the app index) keeps its own order once its slugs are read back from the database, which
 * returns rows in any order. A slug with no row (not visible to this viewer) is skipped, and a
 * slug named twice is kept once, at its first position.
 */
export function idsInSlugOrder(
  slugs: readonly string[],
  rows: ReadonlyArray<{ id: string; slug: string }>
): string[] {
  const idBySlug = new Map(rows.map((r) => [r.slug, r.id] as const));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slug of slugs) {
    const id = idBySlug.get(slug);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

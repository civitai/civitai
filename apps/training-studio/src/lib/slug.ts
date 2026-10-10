/** A run name as a tag-safe, filesystem-safe slug. The `name:<slug>` workflow tag, the archive entry
 *  names and every downloaded filename derive from the title this one way, so they never disagree. */
export function slugify(name: string, fallback = ''): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || fallback
  );
}

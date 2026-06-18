// Vendored from the app's ~/utils/string-helpers (like slugit -> @civitai/redis). Kept here so
// the package has no app imports. Used to derive a plain-text fallback from HTML email bodies.
export function removeTags(str: string): string {
  if (!str) return '';
  // `[^<>]` (not `[^>]`) so an unterminated run of `<` can't force quadratic backtracking
  // (ReDoS) — a `<` always starts a fresh potential tag instead of being consumed mid-tag.
  const stringWithoutTags = str.replace(/<[^<>]*>/g, ' ');
  const stringWithoutExtraSpaces = stringWithoutTags.replace(/\s+/g, ' ');
  return stringWithoutExtraSpaces.trim();
}

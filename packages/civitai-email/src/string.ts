// Vendored from the app's ~/utils/string-helpers (like slugit -> @civitai/redis). Kept here so
// the package has no app imports. Used to derive a plain-text fallback from HTML email bodies.
export function removeTags(str: string): string {
  if (!str) return '';
  const stringWithoutTags = str.replace(/<[^>]*>/g, ' ');
  const stringWithoutExtraSpaces = stringWithoutTags.replace(/\s+/g, ' ');
  return stringWithoutExtraSpaces.trim();
}

// The accent fold on its own, in a module with no dependencies. `normalize-text.ts` composes it
// with entity decoding; callers that only ever see display strings take it directly, which is what
// keeps `he` out of the chunk the feed loads. See hasNsfwWords in metadata/audit-base.ts.
export function foldDiacritics(input?: string): string {
  if (!input) return '';
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

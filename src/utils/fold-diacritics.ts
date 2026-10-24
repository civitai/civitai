// The accent fold alone, with no dependencies, and it has to stay that way: it exists so callers
// that only ever see display strings can skip normalize-text.ts and the entity table that module
// imports. Teaching this one to decode entities would undo that.
export function foldDiacritics(input?: string): string {
  if (!input) return '';
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

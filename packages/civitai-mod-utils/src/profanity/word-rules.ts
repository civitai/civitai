/**
 * Normalise a blocked-list entry: strip regex syntax but keep the `|` word-boundary markers.
 */
export function cleanWord(word: string): string {
  return word
    .replace(/\\w\*/g, '')
    .replace(/\?/g, '')
    .replace(/[\[\](){}]/g, '')
    .replace(/[*+]/g, '')
    .trim()
    .toLowerCase();
}

/** Whether the profanity filter keeps an entry when it builds its word list. */
export function isValidWord(word: string): boolean {
  const cleaned = cleanWord(word);
  const contentWithoutPipes = cleaned.replace(/\|/g, '');
  const minLength = cleaned.includes('|') ? 1 : 2;

  return (
    contentWithoutPipes.length >= minLength &&
    !cleaned.includes('\\') &&
    /^[a-z\s\-'|]+$/i.test(cleaned)
  );
}

/** The filter adds only words at least this long to its dataset, pipes included. */
export const MIN_DATASET_WORD_LENGTH = 3;

/** An entry with no `|` at either end matches inside any word, so it needs more letters. */
export const MIN_UNBOUNDED_LETTERS = 4;

/**
 * Whether a moderator entry would take effect in the filter and is long enough to be safe to
 * apply everywhere. Stricter than the filter on short boundary-marked entries, and refuses a
 * `|` anywhere but the ends, which the filter's pattern parser throws on.
 */
export function isUsableBlockedEntry(entry: string): boolean {
  const cleaned = cleanWord(entry);
  return (
    isValidWord(entry) &&
    !cleaned.slice(1, -1).includes('|') &&
    cleaned.length >= MIN_DATASET_WORD_LENGTH &&
    cleaned.replace(/[^a-z]/g, '').length >=
      (cleaned.startsWith('|') || cleaned.endsWith('|')
        ? MIN_DATASET_WORD_LENGTH
        : MIN_UNBOUNDED_LETTERS)
  );
}

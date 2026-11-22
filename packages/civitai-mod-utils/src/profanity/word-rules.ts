import { blockedWords } from './lists';

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

/**
 * An entry with no `|` at either end matches inside any word, so it needs more letters, unless
 * aligned with the shipped list.
 */
export const MIN_UNBOUNDED_LETTERS = 4;

// Keeps a managed copy of the shipped list aligned with it.
let shippedEntries: ReadonlySet<string> | undefined;
function isShippedEntry(cleaned: string): boolean {
  shippedEntries ??= new Set(blockedWords.map(cleanWord));
  return shippedEntries.has(cleaned);
}

/**
 * Whether a moderator entry is usable in a managed list. Stricter than the filter on short
 * boundary-marked entries, and refuses a `|` anywhere but the ends, which the filter's pattern
 * parser throws on.
 */
export function isUsableBlockedEntry(entry: string): boolean {
  const cleaned = cleanWord(entry);
  return (
    isValidWord(entry) &&
    !cleaned.slice(1, -1).includes('|') &&
    cleaned.length >= MIN_DATASET_WORD_LENGTH &&
    cleaned.replace(/[^a-z]/g, '').length >=
      (cleaned.startsWith('|') || cleaned.endsWith('|') || isShippedEntry(cleaned)
        ? MIN_DATASET_WORD_LENGTH
        : MIN_UNBOUNDED_LETTERS)
  );
}

/**
 * The fewest usable entries a managed profanity block list may hold. Below it the server enforces
 * the shipped list instead, and the moderator app refuses a removal that would cross it, so a wiped
 * or mangled row cannot shrink what the filter enforces below this count.
 */
export const MIN_MANAGED_PROFANITY_ENTRIES = 192;

/**
 * The usable entries of a managed profanity block list, and whether there are enough of them for
 * the list to be enforced. The server filter and the moderator app's removal guard both decide
 * through this, so a change to the rule reaches each of them.
 *
 * `distinct` counts entries the way the filter keys them (by `cleanWord`), so spellings of one
 * entry count once toward the floor.
 */
export function managedProfanityEntries(entries: readonly string[]): {
  usable: string[];
  distinct: number;
  enforced: boolean;
} {
  const usable = entries.filter(isUsableBlockedEntry);
  const distinct = new Set(usable.map(cleanWord)).size;
  return { usable, distinct, enforced: distinct >= MIN_MANAGED_PROFANITY_ENTRIES };
}

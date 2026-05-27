import { createProfanityFilter, type SimpleProfanityFilter } from '~/libs/profanity-simple';

export type ProfanityListKind = 'display' | 'search';

type Entry = { words: string[]; filter: SimpleProfanityFilter };

// Singleton per process. The client populates it lazily via the
// `system.getProfanityLists` query; the server uses `list-loader` directly
// and doesn't go through here.
const entries = new Map<ProfanityListKind, Entry>();
const listeners = new Set<() => void>();

export function getProfanityFilter(kind: ProfanityListKind): SimpleProfanityFilter | null {
  return entries.get(kind)?.filter ?? null;
}

export function setProfanityList(kind: ProfanityListKind, words: string[]): void {
  const current = entries.get(kind);
  if (
    current &&
    current.words.length === words.length &&
    current.words.every((w, i) => w === words[i])
  ) {
    return;
  }
  entries.set(kind, { words, filter: createProfanityFilter({ blockedWords: words }) });
  listeners.forEach((listener) => listener());
}

export function subscribeProfanity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

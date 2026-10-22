import { aliasKindField } from '@civitai/moderation/model-rules';
import type { AliasSuggestion } from './suggest-aliases';

/**
 * Billed suggestions, held per rule in this browser until a moderator approves or discards them.
 * `updatedAt` is the rule's version they were fetched for.
 */
export type StoredSuggestions = {
  updatedAt: string;
  costTotal?: number;
  suggestions: AliasSuggestion[];
};
type Held = Record<number, StoredSuggestions>;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const aliasSuggestionsKey = (moderatorId: number) =>
  `model-rules:alias-suggestions:${moderatorId}`;

const isoOf = (value: Date | string) => new Date(value).toISOString();

function readEntry(value: unknown): StoredSuggestions | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.updatedAt !== 'string' || !Array.isArray(v.suggestions)) return null;
  const suggestions: AliasSuggestion[] = [];
  for (const raw of v.suggestions) {
    const s = raw as Record<string, unknown> | null;
    if (!s || typeof s.alias !== 'string' || !s.alias.trim()) continue;
    suggestions.push({
      alias: s.alias,
      kind: aliasKindField.parse(s.kind),
      ...(typeof s.note === 'string' && s.note ? { note: s.note } : {}),
      // Stored text reaches an href, so it is held to the same http(s) rule as a fresh answer.
      ...(typeof s.source === 'string' && /^https?:\/\//.test(s.source) ? { source: s.source } : {}),
    });
  }
  return {
    updatedAt: v.updatedAt,
    ...(typeof v.costTotal === 'number' && Number.isFinite(v.costTotal)
      ? { costTotal: v.costTotal }
      : {}),
    suggestions,
  };
}

/** Never throws: unreadable storage reads as nothing held. */
export function readSuggestions(store: Store | null, key: string): Held {
  let parsed: unknown;
  try {
    const raw = store?.getItem(key);
    if (!raw) return {};
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Held = {};
  for (const [id, value] of Object.entries(parsed)) {
    const entry = /^[1-9]\d*$/.test(id) ? readEntry(value) : null;
    if (entry) out[Number(id)] = entry;
  }
  return out;
}

/** False when the browser refused the write: the caller still holds the suggestions in memory. */
export function writeSuggestions(store: Store | null, key: string, held: Held): boolean {
  try {
    if (!store) return false;
    if (Object.keys(held).length) store.setItem(key, JSON.stringify(held));
    else store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export const isStaleSuggestion = (entry: StoredSuggestions, ruleUpdatedAt: Date | string) =>
  entry.updatedAt !== isoOf(ruleUpdatedAt);

export function pruneSuggestions(held: Held, rules: readonly { id: number }[]): Held {
  const ids = new Set(rules.map((r) => r.id));
  return Object.fromEntries(Object.entries(held).filter(([id]) => ids.has(Number(id))));
}

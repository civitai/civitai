import { aliasKindField, aliasWorkflowIdField } from '@civitai/moderation/model-rules';
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
      ...(typeof s.source === 'string' && /^https?:\/\//.test(s.source)
        ? { source: s.source }
        : {}),
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

/**
 * A billed search that was submitted and may still be running, held per rule so a reload resumes
 * polling it instead of paying for a second one. `updatedAt` is the rule version it was started for.
 */
export type PendingSearch = { updatedAt: string; workflowId: string };
type PendingMap = Record<number, PendingSearch>;

export const aliasPendingKey = (moderatorId: number) => `model-rules:alias-pending:${moderatorId}`;

/** Never throws: unreadable storage reads as nothing pending. */
export function readPending(store: Store | null, key: string): PendingMap {
  let parsed: unknown;
  try {
    const raw = store?.getItem(key);
    if (!raw) return {};
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: PendingMap = {};
  for (const [id, value] of Object.entries(parsed)) {
    const v = value as Record<string, unknown> | null;
    const workflowId = aliasWorkflowIdField.safeParse(v?.workflowId);
    if (/^[1-9]\d*$/.test(id) && typeof v?.updatedAt === 'string' && workflowId.success)
      out[Number(id)] = { updatedAt: v.updatedAt, workflowId: workflowId.data };
  }
  return out;
}

/**
 * Sets or (with null) clears one rule's pending search. It re-reads first: the backfill view and a
 * rule's own editor both write this key, and neither may overwrite the other's entries.
 * False when the browser refused the write.
 */
export function setPending(
  store: Store | null,
  key: string,
  ruleId: number,
  entry: PendingSearch | null
): boolean {
  const pending = readPending(store, key);
  if (entry) pending[ruleId] = entry;
  else delete pending[ruleId];
  try {
    if (!store) return false;
    if (Object.keys(pending).length) store.setItem(key, JSON.stringify(pending));
    else store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export const isStalePending = (entry: PendingSearch, ruleUpdatedAt: Date | string) =>
  entry.updatedAt !== isoOf(ruleUpdatedAt);

export function prunePending(pending: PendingMap, rules: readonly { id: number }[]): PendingMap {
  const ids = new Set(rules.map((r) => r.id));
  return Object.fromEntries(Object.entries(pending).filter(([id]) => ids.has(Number(id))));
}

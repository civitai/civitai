import { blankPromptKeys, describeBlankPrompts } from '$lib/text-scan-lab/labels';
import { PROMPT_KEYS, type PromptChanges, type PromptKey } from '$lib/text-scan-lab/types';

/**
 * A moderator's prompt changes live only in this browser, one entry per moderator so a shared browser
 * never mixes two people's changes. Storage can be missing or throw (private windows, blocked site
 * data): every access is guarded, and the changes then last as long as the page.
 */
export const changesStorageKey = (moderatorId: number) => `text-scan-lab:changes:${moderatorId}`;

/** `baseId`: the current version's id when the edit started, null when there was none. Publishing
 *  refuses a change whose base is no longer current, so it cannot silently revert someone's version. */
export type StoredChange = { text: string; baseId: number | null };
export type StoredChanges = Partial<Record<PromptKey, StoredChange>>;

export type CurrentPrompts = {
  content: Partial<Record<PromptKey, string>>;
  ids: Partial<Record<PromptKey, number>>;
};

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const isStoredChange = (v: unknown): v is StoredChange =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as StoredChange).text === 'string' &&
  ((v as StoredChange).baseId === null || Number.isInteger((v as StoredChange).baseId));

/** Null when storage cannot be read at all, as opposed to holding nothing. */
function readStored(store: Store | null, key: string): StoredChanges | null {
  let raw: string | null;
  try {
    if (!store) return null;
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: StoredChanges = {};
  for (const k of PROMPT_KEYS) {
    const v = (parsed as Record<string, unknown>)[k];
    if (isStoredChange(v)) out[k] = { text: v.text, baseId: v.baseId };
  }
  return out;
}

export const readChanges = (store: Store | null, key: string): StoredChanges =>
  readStored(store, key) ?? {};

export function writeChanges(store: Store | null, key: string, changes: StoredChanges) {
  try {
    if (Object.keys(changes).length) store?.setItem(key, JSON.stringify(changes));
    else store?.removeItem(key);
  } catch {
    // Kept in memory for this page only.
  }
}

export type ChangesFields = { changes: StoredChanges; current: CurrentPrompts | null };

export class ChangesState {
  #f: ChangesFields;
  #store: Store | null;
  #key: string;

  constructor(fields: ChangesFields, store: Store | null, key: string) {
    this.#f = fields;
    this.#store = store;
    this.#key = key;
  }

  /**
   * Loads the stored changes; called once the page is in the browser, so server and client render the
   * same first frame. `current` is null when the current prompts did not load.
   */
  restore(current: CurrentPrompts | null) {
    this.#f.current = current;
    this.reload();
  }

  /** New current prompts (after a publish, say): a change whose text is now live is dropped. */
  setCurrent(current: CurrentPrompts | null) {
    this.#f.current = current;
    this.#prune();
  }

  /** Re-reads storage, for a change saved in another tab. */
  reload() {
    const stored = readStored(this.#store, this.#key);
    if (stored) this.#f.changes = stored;
    this.#prune();
  }

  /** The changed text per key: what a check scans as "With my changes", and what publish sends. */
  get prompts(): PromptChanges {
    return Object.fromEntries(this.keys.map((k) => [k, this.#f.changes[k]!.text])) as PromptChanges;
  }

  get baseIds(): Partial<Record<PromptKey, number | null>> {
    return Object.fromEntries(this.keys.map((k) => [k, this.#f.changes[k]!.baseId]));
  }

  get keys(): PromptKey[] {
    return PROMPT_KEYS.filter((k) => k in this.#f.changes);
  }

  /** Changes written against a version that is no longer current. Unknown while current is unloaded. */
  get stale(): PromptKey[] {
    const current = this.#f.current;
    if (!current) return [];
    return this.keys.filter((k) => this.#f.changes[k]!.baseId !== (current.ids[k] ?? null));
  }

  get json(): string {
    return JSON.stringify(this.prompts);
  }

  get blankError(): string | null {
    const blank = blankPromptKeys(this.prompts);
    return blank.length ? describeBlankPrompts(blank) : null;
  }

  set(key: PromptKey, text: string) {
    const current = this.#f.current;
    const { [key]: old, ...rest } = this.#f.changes;
    this.#f.changes =
      text === current?.content[key]
        ? rest
        : { ...rest, [key]: { text, baseId: old ? old.baseId : current?.ids[key] ?? null } };
    this.#save([key]);
  }

  /** Keeps this text over the newer version: it is now written against the current one. */
  keepMine(key: PromptKey) {
    const change = this.#f.changes[key];
    if (!change || !this.#f.current) return;
    this.#f.changes = {
      ...this.#f.changes,
      [key]: { text: change.text, baseId: this.#f.current.ids[key] ?? null },
    };
    this.#save([key]);
  }

  drop(keys: readonly PromptKey[]) {
    const gone = this.keys.filter((k) => keys.includes(k));
    if (!gone.length) return;
    const { ...kept } = this.#f.changes;
    for (const k of gone) delete kept[k];
    this.#f.changes = kept;
    this.#save(gone);
  }

  discard() {
    this.#f.changes = {};
    this.#save(PROMPT_KEYS);
  }

  #prune() {
    const content = this.#f.current?.content;
    if (!content) return;
    this.drop(this.keys.filter((k) => this.#f.changes[k]!.text === content[k]));
  }

  // Another tab may have saved since this one read: keep its other keys, and this tab's `touched` ones.
  #save(touched: readonly PromptKey[]) {
    const merged: StoredChanges = { ...(readStored(this.#store, this.#key) ?? this.#f.changes) };
    for (const k of touched) {
      const mine = this.#f.changes[k];
      if (mine) merged[k] = mine;
      else delete merged[k];
    }
    writeChanges(this.#store, this.#key, merged);
    this.#f.changes = merged;
  }
}

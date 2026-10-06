import { blankPromptKeys, describeBlankPrompts } from '$lib/text-scan-lab/labels';
import { PROMPT_KEYS, type PromptChanges, type PromptKey } from '$lib/text-scan-lab/types';

/**
 * A moderator's prompt changes live only in this browser, one entry per moderator so a shared browser
 * never mixes two people's changes. Storage can be missing or throw (private windows, blocked site
 * data): every access is guarded, and the changes then last as long as the page.
 */
export const changesStorageKey = (moderatorId: number) => `text-scan-lab:changes:${moderatorId}`;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readChanges(store: Store | null, key: string): PromptChanges {
  let raw: string | null = null;
  try {
    raw = store?.getItem(key) ?? null;
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: PromptChanges = {};
  for (const k of PROMPT_KEYS) {
    const v = (parsed as Record<string, unknown>)[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export function writeChanges(store: Store | null, key: string, prompts: PromptChanges) {
  try {
    if (Object.keys(prompts).length) store?.setItem(key, JSON.stringify(prompts));
    else store?.removeItem(key);
  } catch {
    // Kept in memory for this page only.
  }
}

export type ChangesFields = { prompts: PromptChanges };

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
   * same first frame. Changes equal to the current text are dropped: they were published, or reset.
   */
  restore(current: Partial<Record<PromptKey, string>>) {
    const stored = readChanges(this.#store, this.#key);
    const kept = Object.fromEntries(
      Object.entries(stored).filter(([k, v]) => current[k as PromptKey] !== v)
    ) as PromptChanges;
    this.#f.prompts = kept;
    if (Object.keys(kept).length !== Object.keys(stored).length) this.#save();
  }

  get prompts(): PromptChanges {
    return this.#f.prompts;
  }

  get keys(): PromptKey[] {
    return PROMPT_KEYS.filter((k) => k in this.#f.prompts);
  }

  get json(): string {
    return JSON.stringify(this.#f.prompts);
  }

  get blankError(): string | null {
    const blank = blankPromptKeys(this.#f.prompts);
    return blank.length ? describeBlankPrompts(blank) : null;
  }

  set(key: PromptKey, text: string, current: string | undefined) {
    const { [key]: _old, ...rest } = this.#f.prompts;
    this.#f.prompts = text === current ? rest : { ...rest, [key]: text };
    this.#save();
  }

  resetKey(key: PromptKey) {
    if (!(key in this.#f.prompts)) return;
    const { [key]: _old, ...rest } = this.#f.prompts;
    this.#f.prompts = rest;
    this.#save();
  }

  discard() {
    this.#f.prompts = {};
    this.#save();
  }

  #save() {
    writeChanges(this.#store, this.#key, this.#f.prompts);
  }
}

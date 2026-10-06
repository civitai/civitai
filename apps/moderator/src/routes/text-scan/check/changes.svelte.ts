import type { ActionResult, SubmitFunction } from '@sveltejs/kit';
import { deserialize } from '$app/forms';
import type { FormState } from '$lib/form-state.svelte';
import type { DraftPrompts } from '$lib/server/text-scan-lab/drafts.service';
import { promptKeyName } from '$lib/text-scan-lab/labels';
import { PROMPT_KEYS, type PromptKey } from '$lib/text-scan-lab/types';

const AUTOSAVE_MS = 800;

/** Posts to one of this page's actions outside a form (autosave, discard, copy). */
export async function postAction(
  name: string,
  fields: Record<string, string>
): Promise<ActionResult> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  try {
    const res = await fetch(`/text-scan/check?/${name}`, {
      method: 'POST',
      body,
      headers: { 'x-sveltekit-action': 'true' },
    });
    return deserialize(await res.text());
  } catch {
    return { type: 'failure', status: 0, data: { error: 'Could not reach the server.' } };
  }
}

export const actionError = (result: ActionResult) =>
  result.type === 'failure'
    ? (result.data?.error as string | undefined) ?? 'Something went wrong.'
    : result.type === 'error'
    ? (result.error as { message?: string } | undefined)?.message || 'Something went wrong.'
    : null;

export type ChangesInit = {
  prompts: DraftPrompts;
  draftId: number | null;
  /** The saved row's `updatedAt`, the conflict token; null while no row exists. */
  token: string | null;
  /** A proposed draft its author is editing; null for the moderator's own working copy. */
  target: number | null;
  editable: boolean;
};

/**
 * The prompt changes the page tests, auto-saved. Saves run one at a time, each sending the token the
 * previous one returned. A conflict stops autosave until the page reloads: saving over another tab's
 * version would silently drop it.
 */
export class ChangesState {
  prompts = $state<DraftPrompts>({});
  draftId = $state<number | null>(null);
  token = $state<string | null>(null);
  editable = $state(false);
  saving = $state(false);
  error = $state<string | null>(null);
  conflict = $state(false);

  #target: number | null = null;
  #savedJson = $state('{}');
  #timer: ReturnType<typeof setTimeout> | undefined;
  #chain: Promise<boolean> = Promise.resolve(true);
  // Bumped on reset, so a save answered after it cannot write into the new state.
  #generation = 0;

  constructor(init: ChangesInit) {
    this.reset(init);
  }

  reset(init: ChangesInit) {
    clearTimeout(this.#timer);
    this.#generation++;
    this.prompts = init.prompts;
    this.draftId = init.draftId;
    this.token = init.token;
    this.editable = init.editable;
    this.#target = init.target;
    this.#savedJson = JSON.stringify(init.prompts);
    this.saving = false;
    this.error = null;
    this.conflict = false;
  }

  get keys(): PromptKey[] {
    return PROMPT_KEYS.filter((k) => k in this.prompts);
  }

  get json(): string {
    return JSON.stringify(this.prompts);
  }

  get dirty(): boolean {
    return this.json !== this.#savedJson;
  }

  /** A version equal to the current text is no change, so it leaves the set. */
  set(key: PromptKey, text: string, current: string | undefined) {
    if (!this.editable) return;
    const { [key]: _old, ...rest } = this.prompts;
    this.prompts = text === current ? rest : { ...rest, [key]: text };
    this.#schedule();
  }

  resetKey(key: PromptKey) {
    if (!this.editable || !(key in this.prompts)) return;
    const { [key]: _old, ...rest } = this.prompts;
    this.prompts = rest;
    this.#schedule();
  }

  /** Saves now; resolves true once what is on screen is saved. */
  flush(): Promise<boolean> {
    clearTimeout(this.#timer);
    this.#chain = this.#chain.then(() => this.#save());
    return this.#chain;
  }

  /** Stops autosave and waits out a save in flight, so nothing recreates the copy afterwards. */
  async settle() {
    clearTimeout(this.#timer);
    this.#generation++;
    await this.#chain;
  }

  #schedule() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush(), AUTOSAVE_MS);
  }

  // Loops until what is on screen is saved, so a flush during an edit made mid-save still covers it.
  async #save(): Promise<boolean> {
    for (;;) {
      if (!this.editable || this.conflict) return !this.dirty;
      const json = this.json;
      if (json === this.#savedJson) return true;
      const blank = this.keys.filter((k) => !this.prompts[k]?.trim());
      if (blank.length) {
        this.error = `${blank.map(promptKeyName).join(', ')} ${
          blank.length === 1 ? 'is' : 'are'
        } empty — write it, or reset it to current.`;
        return false;
      }

      const generation = this.#generation;
      this.saving = true;
      const result = await postAction('saveChanges', {
        prompts: json,
        expectedUpdatedAt: this.token ?? '',
        ...(this.#target !== null ? { draftId: String(this.#target) } : {}),
      });
      if (generation !== this.#generation) return false;
      this.saving = false;
      if (result.type !== 'success') {
        this.error = actionError(result);
        if (result.type === 'failure' && result.status === 409) this.conflict = true;
        return false;
      }
      this.token = (result.data?.updatedAt as string | null) ?? null;
      this.draftId = (result.data?.draftId as number | null) ?? null;
      this.#savedJson = json;
      this.error = null;
    }
  }
}

/**
 * For Propose and Publish: saves the changes first, then submits with the id and token of exactly what
 * was saved, so the server acts on what the moderator is looking at.
 */
export function submitSaved(changes: ChangesState, form: FormState): SubmitFunction {
  return async (input) => {
    form.submitting = true;
    const saved = await changes.flush();
    form.submitting = false;
    if (!saved || changes.draftId === null || changes.token === null) {
      input.cancel();
      form.error = saved
        ? 'There are no changes to send.'
        : changes.error ?? 'Your changes could not be saved.';
      return;
    }
    input.formData.set('draftId', String(changes.draftId));
    input.formData.set('expectedUpdatedAt', changes.token);
    return form.enhance(input);
  };
}

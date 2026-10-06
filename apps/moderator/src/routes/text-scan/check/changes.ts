import type { ActionResult, SubmitFunction } from '@sveltejs/kit';
import type { DraftPrompts } from '$lib/server/text-scan-lab/drafts.service';
import { blankPromptKeys, describeBlankPrompts } from '$lib/text-scan-lab/labels';
import { PROMPT_KEYS, type PromptKey } from '$lib/text-scan-lab/types';
import type { PostAction } from './post-action';

export const AUTOSAVE_MS = 800;
/** Browsers refuse a keepalive request whose body (with every other one in flight) is over 64KiB. */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;

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

/** Everything the page renders from. The page passes these in as `$state`, a test as a plain object. */
export type ChangesFields = {
  prompts: DraftPrompts;
  draftId: number | null;
  token: string | null;
  editable: boolean;
  saving: boolean;
  error: string | null;
  conflict: boolean;
  savedJson: string;
};

export const emptyChangesFields = (): ChangesFields => ({
  prompts: {},
  draftId: null,
  token: null,
  editable: false,
  saving: false,
  error: null,
  conflict: false,
  savedJson: '{}',
});

/**
 * The prompt changes the page tests, auto-saved. Saves run one at a time, each sending the token the
 * previous one returned. A conflict stops autosave until the page reloads: saving over another tab's
 * version would silently drop it.
 */
export class ChangesState {
  #f: ChangesFields;
  #post: PostAction;
  #target: number | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #chain: Promise<boolean> = Promise.resolve(true);
  // Bumped on reset, so a save answered after it cannot write into the new state.
  #generation = 0;

  constructor(fields: ChangesFields, post: PostAction, init: ChangesInit) {
    this.#f = fields;
    this.#post = post;
    this.reset(init);
  }

  get prompts() {
    return this.#f.prompts;
  }
  get draftId() {
    return this.#f.draftId;
  }
  get token() {
    return this.#f.token;
  }
  get editable() {
    return this.#f.editable;
  }
  get saving() {
    return this.#f.saving;
  }
  get error() {
    return this.#f.error;
  }
  get conflict() {
    return this.#f.conflict;
  }

  reset(init: ChangesInit) {
    clearTimeout(this.#timer);
    this.#generation++;
    this.#target = init.target;
    Object.assign(this.#f, {
      prompts: init.prompts,
      draftId: init.draftId,
      token: init.token,
      editable: init.editable,
      saving: false,
      error: null,
      conflict: false,
      savedJson: JSON.stringify(init.prompts),
    } satisfies ChangesFields);
  }

  get keys(): PromptKey[] {
    return PROMPT_KEYS.filter((k) => k in this.#f.prompts);
  }

  get json(): string {
    return JSON.stringify(this.#f.prompts);
  }

  get dirty(): boolean {
    return this.json !== this.#f.savedJson;
  }

  /** Why the changes cannot be saved or tested as they stand, or null. */
  get blankError(): string | null {
    const blank = blankPromptKeys(this.#f.prompts);
    return blank.length ? describeBlankPrompts(blank) : null;
  }

  /** A version equal to the current text is no change, so it leaves the set. */
  set(key: PromptKey, text: string, current: string | undefined) {
    if (!this.editable) return;
    const { [key]: _old, ...rest } = this.#f.prompts;
    this.#f.prompts = text === current ? rest : { ...rest, [key]: text };
    this.#schedule();
  }

  resetKey(key: PromptKey) {
    if (!this.editable || !(key in this.#f.prompts)) return;
    const { [key]: _old, ...rest } = this.#f.prompts;
    this.#f.prompts = rest;
    this.#schedule();
  }

  /** Saves now; resolves true once what is on screen is saved. */
  flush(): Promise<boolean> {
    clearTimeout(this.#timer);
    this.#chain = this.#chain.then(() => this.#save());
    return this.#chain;
  }

  /**
   * As the page unloads: sends the save at once as a keepalive request, which outlives the page, and
   * says whether that covers the changes. False means the browser should ask before leaving: a save in
   * flight would turn this one into a conflict, and an oversize body would never be sent.
   */
  saveOnLeave(): boolean {
    const f = this.#f;
    if (!this.dirty) return true;
    if (!f.editable || f.conflict || f.saving || this.blankError) return false;
    const fields = this.#saveFields();
    const bytes = new Blob(Object.entries(fields).flat()).size;
    if (bytes > KEEPALIVE_MAX_BYTES) return false;
    clearTimeout(this.#timer);
    void this.#post('saveChanges', fields, { keepalive: true });
    return true;
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
  #saveFields(): Record<string, string> {
    return {
      prompts: this.json,
      expectedUpdatedAt: this.#f.token ?? '',
      ...(this.#target !== null ? { draftId: String(this.#target) } : {}),
    };
  }

  async #save(): Promise<boolean> {
    const f = this.#f;
    for (;;) {
      if (!f.editable || f.conflict) return !this.dirty;
      const json = this.json;
      if (json === f.savedJson) return true;
      const blank = this.blankError;
      if (blank) {
        f.error = blank;
        return false;
      }

      const generation = this.#generation;
      f.saving = true;
      const result = await this.#post('saveChanges', this.#saveFields());
      if (generation !== this.#generation) return false;
      f.saving = false;
      if (result.type !== 'success') {
        f.error = actionError(result);
        if (result.type === 'failure' && result.status === 409) f.conflict = true;
        return false;
      }
      f.token = (result.data?.updatedAt as string | null) ?? null;
      f.draftId = (result.data?.draftId as number | null) ?? null;
      f.savedJson = json;
      f.error = null;
    }
  }
}

/** The slice of `FormState` that `submitSaved` drives. */
type SubmittingForm = { submitting: boolean; error: string | null; enhance: SubmitFunction };

/**
 * For Propose and Publish: saves the changes first, then submits with the id and token of exactly what
 * was saved, so the server acts on what the moderator is looking at.
 */
export function submitSaved(changes: ChangesState, form: SubmittingForm): SubmitFunction {
  return async (input) => {
    // Held through the save; the form's own enhance keeps it set for the request.
    form.submitting = true;
    const saved = await changes.flush();
    if (!saved || changes.draftId === null || changes.token === null) {
      form.submitting = false;
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

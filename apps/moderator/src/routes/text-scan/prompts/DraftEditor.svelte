<script lang="ts">
  import type { Snippet } from 'svelte';
  import { enhance } from '$app/forms';
  import { beforeNavigate } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS } from '$lib/format';
  import type { DraftPrompts, PromptDraft } from '$lib/server/text-scan-lab/drafts.service';
  import type { LabPrompt } from '$lib/server/text-scan-lab/harness-client';
  import { PROMPT_KEYS, type PromptKey } from '$lib/text-scan-lab/types';
  import DiffView from './DiffView.svelte';

  let {
    draft,
    promptKey,
    active,
    activeLoaded,
    publish,
  }: {
    draft: PromptDraft;
    promptKey: PromptKey;
    active: LabPrompt | undefined;
    activeLoaded: boolean;
    publish?: Snippet<[{ dirty: boolean }]>;
  } = $props();

  // `null` = showing what is saved. The conflict token is the updated_at the FIRST edit was made
  // against, not the latest load: switching key re-runs `load`, and sending the fresh value would let
  // these edits silently overwrite a save another tab made in between.
  let edits = $state<DraftPrompts | null>(null);
  let editNote = $state<string | null>(null);
  let editBase = $state<string | null>(null);
  let comparing = $state(false);

  const prompts = $derived(edits ?? draft.prompts);
  const note = $derived(editNote ?? draft.note ?? '');
  const dirty = $derived(edits !== null || editNote !== null);
  const readOnly = $derived(draft.publishedAt !== null);
  const overridden = $derived(promptKey in prompts);

  function beginEdit() {
    if (!dirty) editBase = draft.updatedAt.toISOString();
  }
  function setPrompts(next: DraftPrompts) {
    beginEdit();
    edits = next;
  }
  function setNote(v: string) {
    beginEdit();
    editNote = v;
  }
  function removeKey(key: PromptKey) {
    const { [key]: _removed, ...rest } = prompts;
    setPrompts(rest);
  }
  function discard() {
    edits = null;
    editNote = null;
    editBase = null;
  }

  // Another draft (or page) remounts this editor and drops the edits; switching key keeps them.
  beforeNavigate((nav) => {
    if (!dirty) return;
    const to = nav.to?.url;
    if (to && to.pathname === nav.from?.url.pathname && to.searchParams.get('draft') === String(draft.id))
      return;
    if (nav.type === 'leave') nav.cancel();
    else if (!confirm(`Discard unsaved changes to "${draft.name}"?`)) nav.cancel();
  });

  const save = new FormState({
    reload: true,
    reset: false,
    onSuccess: () => {
      discard();
      toast.success('Draft saved');
    },
  });
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h2 class="text-sm font-semibold text-white">
      Draft · {draft.name}
      {#if readOnly}<span class="text-xs font-normal text-green-300">published</span>{/if}
    </h2>
    <Button href="/text-scan/check?draft={draft.id}" size="sm" variant="outline">
      Open in Check
    </Button>
  </div>
  {#if dirty}
    <p class="mt-1 text-xs text-amber-300">Unsaved changes — Check runs the saved draft.</p>
  {/if}

  <p class="mt-3 text-xs text-dark-2">
    Overrides:
    {#each PROMPT_KEYS.filter((k) => k in prompts) as key (key)}
      <a href="?draft={draft.id}&key={key}" class="ml-1 {LINK_CLASS}">{key}</a>
    {:else}
      none — every key runs active.
    {/each}
  </p>

  <div class="mt-4">
    {#if overridden}
      <div class="flex items-center justify-between gap-2">
        <Label for="draft-prompt" class="text-xs text-dark-2">{promptKey}</Label>
        <div class="flex gap-2">
          {#if active}
            <Button size="xs" variant="ghost" onclick={() => (comparing = !comparing)}>
              {comparing ? 'Hide changes' : 'Compare with active'}
            </Button>
          {/if}
          {#if !readOnly}
            <Button size="xs" variant="ghost" onclick={() => removeKey(promptKey)}>
              Remove override
            </Button>
          {/if}
        </div>
      </div>
      {#if comparing && active}
        <div class="mt-2">
          <DiffView before={active.content} after={prompts[promptKey] ?? ''} />
        </div>
      {/if}
      {#if readOnly}
        <p class="mt-2 text-xs text-dark-2">Published — read only.</p>
      {/if}
      <Textarea
        id="draft-prompt"
        class={cn('mt-2 min-h-72 font-mono text-xs', readOnly && 'cursor-default bg-dark-7 text-dark-1')}
        readonly={readOnly}
        bind:value={
          () => prompts[promptKey] ?? '', (v) => setPrompts({ ...prompts, [promptKey]: v })
        }
      />
    {:else}
      <p class="text-sm text-dark-2">This draft runs the active {promptKey}.</p>
      {#if !readOnly && activeLoaded}
        <Button
          class="mt-2"
          size="sm"
          variant="outline"
          onclick={() => setPrompts({ ...prompts, [promptKey]: active?.content ?? '' })}
        >
          Override {promptKey}
        </Button>
      {:else if !readOnly}
        <p class="mt-2 text-xs text-amber-300">
          The active prompts did not load, so an override cannot start from them — reload to try again.
        </p>
      {/if}
    {/if}
  </div>

  {#if !readOnly}
    <form method="POST" action="?/saveDraft" use:enhance={save.enhance} class="mt-4">
      <input type="hidden" name="draftId" value={draft.id} />
      <input type="hidden" name="prompts" value={JSON.stringify(prompts)} />
      <input
        type="hidden"
        name="expectedUpdatedAt"
        value={editBase ?? draft.updatedAt.toISOString()}
      />
      <Label for="draft-note" class="text-xs text-dark-2">Note</Label>
      <Textarea
        id="draft-note"
        name="note"
        rows={2}
        maxlength={2000}
        class="mt-1"
        bind:value={() => note, setNote}
      />
      <div class="mt-3 flex items-center gap-3">
        <Button type="submit" size="sm" disabled={save.submitting || !dirty}>
          {save.submitting ? 'Saving…' : 'Save draft'}
        </Button>
        {#if dirty}
          <Button size="sm" variant="ghost" onclick={discard}>Discard changes</Button>
        {/if}
      </div>
      {#if save.error}
        <p class="mt-2 text-sm text-red-300">{save.error}</p>
      {/if}
    </form>
  {:else if draft.note}
    <p class="mt-4 text-xs text-dark-2">Note: {draft.note}</p>
  {/if}

  {#if !readOnly && publish}
    {@render publish({ dirty })}
  {/if}
</section>

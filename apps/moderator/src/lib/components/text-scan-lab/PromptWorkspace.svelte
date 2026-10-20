<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ConfirmButton from '$lib/components/ConfirmButton.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { dateTime } from '$lib/format';
  import type { LabPrompts } from '$lib/server/text-scan-lab/harness-client';
  import type { ChangesState } from '$lib/text-scan-lab/changes';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import DiffView from './DiffView.svelte';
  import PromptHistoryDrawer from './PromptHistoryDrawer.svelte';

  let {
    promptKey,
    changes,
    prompts,
    authors,
    canSave,
    saveAction,
    restoreAction,
    saveHint,
  }: {
    promptKey: PromptKey;
    changes: ChangesState;
    prompts: LabPrompts;
    authors: Record<number, string>;
    canSave: boolean;
    saveAction: string;
    restoreAction: string;
    saveHint: string;
  } = $props();

  const active = $derived(prompts.active[promptKey]);
  const latest = $derived(prompts.latest?.[promptKey]);
  const drafted = $derived(changes.keys.includes(promptKey));
  const text = $derived(changes.prompts[promptKey] ?? active?.content ?? '');
  const stale = $derived(changes.stale.includes(promptKey));
  const savedBy = $derived(
    latest?.createdById != null ? ` by ${authors[latest.createdById] ?? 'unknown'}` : ''
  );

  let showDiff = $state(false);
  let historyOpen = $state(false);
  let note = $state('');

  const save = new FormState({
    reload: true,
    reset: false,
    onSuccess: () => {
      changes.drop([promptKey]);
      note = '';
      toast.success(`Saved ${promptKeyName(promptKey)}`);
    },
    onSettled: (result) => {
      if (result.type === 'failure' && result.status === 409) void invalidateAll();
    },
  });

  function discard() {
    changes.drop([promptKey]);
    save.error = null;
  }
</script>

<section class="flex min-h-0 min-w-0 flex-col overflow-y-auto rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h2 class="text-sm font-semibold text-white">
      {promptKeyName(promptKey)}
      {#if drafted}<span class="ml-1 text-xs font-normal text-amber-300">● unsaved</span>{/if}
    </h2>
    <div class="flex items-center gap-2">
      <span class="text-xs text-dark-2">
        {latest ? `Saved ${dateTime(latest.createdAt)}${savedBy}` : 'Never saved'}
      </span>
      <Button size="xs" variant="ghost" onclick={() => (historyOpen = true)}>History</Button>
    </div>
  </div>

  {#if stale}
    <div class="mt-3 rounded-md border border-amber-500/40 p-3 text-sm text-amber-300">
      <p>
        Someone saved a newer version after your draft started. Compare it with your draft, then
        keep your draft or discard it.
      </p>
      <div class="mt-2">
        <DiffView before={active?.content ?? ''} after={text} />
      </div>
      <div class="mt-2 flex gap-2">
        <Button
          size="xs"
          variant="outline"
          onclick={() => {
            changes.keepMine(promptKey);
            save.error = null;
          }}
        >
          Keep my draft
        </Button>
        <ConfirmButton
          size="xs"
          label="Discard"
          title="Discard your draft?"
          description="Your draft of {promptKeyName(promptKey)} is dropped; the saved version is untouched."
          onconfirm={discard}
        />
      </div>
    </div>
  {/if}

  <Textarea
    aria-label="{promptKeyName(promptKey)} text"
    class="mt-3 min-h-96 flex-1 field-sizing-fixed font-mono text-xs"
    bind:value={() => text, (v) => changes.set(promptKey, v)}
  />

  {#if drafted && active}
    <Button
      size="xs"
      variant="ghost"
      class="mt-2 self-start"
      onclick={() => (showDiff = !showDiff)}
    >
      {showDiff ? 'Hide differences' : 'Show differences'}
    </Button>
    {#if showDiff}
      <div class="mt-2"><DiffView before={active.content} after={text} /></div>
    {/if}
  {/if}

  {#if canSave}
    <form
      method="POST"
      action={saveAction}
      use:enhance={save.enhance}
      class="mt-3 flex flex-wrap items-end gap-2 border-t border-dark-4 pt-3"
    >
      <input type="hidden" name="key" value={promptKey} />
      <input type="hidden" name="content" value={text} />
      <input type="hidden" name="baseId" value={changes.baseIds[promptKey] ?? ''} />
      <div class="min-w-48 flex-1">
        <Label for="note-{promptKey}" class="text-xs text-dark-2">Note (optional)</Label>
        <Input id="note-{promptKey}" name="note" maxlength={2000} class="mt-1 h-8" bind:value={note} />
      </div>
      <Button type="submit" size="sm" disabled={!drafted || stale || save.submitting}>
        {save.submitting ? 'Saving…' : 'Save'}
      </Button>
      <ConfirmButton
        size="sm"
        label="Discard"
        title="Discard your draft?"
        description="Your draft of {promptKeyName(promptKey)} is dropped; the saved version is untouched."
        disabled={!drafted}
        onconfirm={discard}
      />
    </form>
    {#if save.error}
      <p class="mt-2 whitespace-pre-wrap text-sm text-red-300">{save.error}</p>
    {/if}
  {:else}
    <p class="mt-3 text-xs text-dark-2">{saveHint} You can still try your draft.</p>
  {/if}
</section>

<PromptHistoryDrawer
  bind:open={historyOpen}
  {promptKey}
  versions={(prompts.history ?? []).filter((v) => v.key === promptKey)}
  currentId={active?.id ?? null}
  {authors}
  {canSave}
  action={restoreAction}
/>

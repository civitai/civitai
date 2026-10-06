<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { LINK_CLASS } from '$lib/format';
  import type { PromptDraft } from '$lib/server/text-scan-lab/drafts.service';
  import type { SetRunTotals } from '$lib/server/text-scan-lab/publish';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import type { ChangesSource } from './+page.server';
  import { actionError, type ChangesState } from './changes';
  import { postAction } from './post-action';
  import ProposeDialog from './ProposeDialog.svelte';
  import PublishDialog from './PublishDialog.svelte';
  import SaveStatus from './SaveStatus.svelte';

  let {
    changes,
    source,
    workingCopy,
    canPublish,
    runTotals,
    onedit,
    onerror,
  }: {
    changes: ChangesState;
    source: ChangesSource;
    /** My own working copy, which "Copy into my changes" replaces. */
    workingCopy: PromptDraft | null;
    canPublish: boolean;
    runTotals: SetRunTotals[];
    onedit: (key: PromptKey) => void;
    /** Reports a refused discard or copy (null clears it). */
    onerror: (error: string | null) => void;
  } = $props();

  let busy = $state(false);

  const viewed = $derived(source.kind === 'draft' ? source.draft : null);
  const publishable = $derived(canPublish && changes.keys.length > 0 && !viewed?.publishedAt);

  async function discard() {
    if (!confirm('Discard all your changes? This cannot be undone.')) return;
    busy = true;
    await changes.settle();
    const error = actionError(await postAction('discardChanges', {}));
    // After the reload, which clears the page's error along with the old changes.
    await invalidateAll();
    onerror(error);
    busy = false;
  }

  async function copyIntoMine() {
    if (!viewed) return;
    if (workingCopy && !confirm('Replace your own changes with this draft?')) return;
    busy = true;
    const result = await postAction('saveChanges', {
      prompts: JSON.stringify(viewed.prompts),
      expectedUpdatedAt: workingCopy?.updatedAt.toISOString() ?? '',
    });
    const error = actionError(result);
    onerror(error);
    if (!error) await goto('/text-scan/check', { invalidateAll: true });
    busy = false;
  }
</script>

{#snippet keyLinks()}
  {#each changes.keys as key, i (key)}
    {i ? ', ' : ''}<button type="button" class={LINK_CLASS} onclick={() => onedit(key)}
      >{promptKeyName(key)}</button
    >
  {:else}
    nothing
  {/each}
{/snippet}

<div
  class="sticky top-0 z-10 mb-4 rounded-xl border border-amber-500/40 bg-dark-6 px-5 py-3 text-sm"
>
  <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
    <p class="min-w-0 flex-1 text-dark-0">
      {#if viewed}
        Testing draft “{viewed.name}”{viewed.publishedAt ? ' (published)' : ''}, which changes:
      {:else}
        You're testing changes to:
      {/if}
      {@render keyLinks()}
    </p>
    <div class="flex flex-wrap items-center gap-2">
      {#if viewed}
        <Button size="sm" variant="outline" disabled={busy} onclick={copyIntoMine}>
          Copy into my changes
        </Button>
        <Button size="sm" variant="ghost" href="/text-scan/check">Back to my changes</Button>
      {:else}
        <Button size="sm" variant="ghost" disabled={busy} onclick={discard}>Discard</Button>
        {#if changes.keys.length}
          <ProposeDialog {changes} />
        {/if}
      {/if}
      {#if publishable}
        <PublishDialog
          {changes}
          {runTotals}
          note={viewed?.note ?? ''}
          draftLabel={viewed ? 'draft' : 'my changes'}
        />
      {/if}
    </div>
  </div>
  {#if viewed?.note}
    <p class="mt-1 text-xs text-dark-2">Note: {viewed.note}</p>
  {/if}
  {#if changes.editable}
    <div class="mt-1"><SaveStatus {changes} /></div>
  {/if}
</div>

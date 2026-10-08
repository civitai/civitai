<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { LINK_CLASS } from '$lib/format';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import type { ChangesState } from './changes';
  import PublishDialog from './PublishDialog.svelte';

  let {
    changes,
    canPublish,
    onedit,
  }: {
    changes: ChangesState;
    canPublish: boolean;
    onedit: (key: PromptKey) => void;
  } = $props();

  function discard() {
    if (confirm('Discard all your changes? This cannot be undone.')) changes.discard();
  }
</script>

{#snippet keyLinks(keys: PromptKey[])}
  {#each keys as key, i (key)}
    {i ? ', ' : ''}<button type="button" class={LINK_CLASS} onclick={() => onedit(key)}
      >{promptKeyName(key)}</button
    >
  {/each}
{/snippet}

<div
  class="sticky top-0 z-10 mb-4 rounded-xl border border-amber-500/40 bg-dark-6 px-5 py-3 text-sm"
>
  <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
    <p class="min-w-0 flex-1 text-dark-0">
      You're testing changes to: {@render keyLinks(changes.keys)}
    </p>
    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" onclick={discard}>Discard</Button>
      {#if canPublish}
        <PublishDialog {changes} disabled={changes.stale.length > 0} />
      {/if}
    </div>
  </div>
  {#if changes.stale.length}
    <p class="mt-1 text-amber-300">
      Written against an older version: {@render keyLinks(changes.stale)}. Someone has published
      since — review the differences, then keep your text or discard it.
    </p>
  {/if}
  <p class="mt-1 text-xs text-dark-2">
    Kept in this browser only. Nobody else sees them until you publish.
  </p>
</div>

<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { SvelteSet } from 'svelte/reactivity';
  import ImageCardModTools from './ImageCardModTools.svelte';
  import TosDeleteButton from './TosDeleteButton.svelte';

  let {
    selected,
    imageIds,
    verdictImageIds,
    reportIds,
    submit,
    appeal,
    minorQueue,
    reported,
  }: {
    selected: SvelteSet<string | number>;
    /** Comma-separated, resolved by the page — a card key is a report id on the reported queue. */
    imageIds: string;
    /** The subset Accept, Remove and the rating tools act on; the rest have only their review flag
     *  left, which is dismissed per card. */
    verdictImageIds: string;
    reportIds: string;
    submit: SubmitFunction;
    /** Appeals resolve rather than accept, and their images are `Blocked` (so: no rating). */
    appeal: boolean;
    minorQueue: boolean;
    /** The report queue names its verdicts after report statuses, not the image ones. */
    reported: boolean;
  } = $props();

  const count = $derived(selected.size);
  // Cards, like every other label here, unless some selected cards take no verdict.
  const verdictCount = $derived(
    verdictImageIds === imageIds ? count : verdictImageIds ? verdictImageIds.split(',').length : 0
  );
  const skipped = $derived(count - verdictCount);
  const acceptLabel = $derived(reported ? 'Unaction' : 'Accept');
</script>

{#if count > 0}
  <!-- spacer so the fixed bar can't cover the last row / Next button -->
  <div class="h-20"></div>
  <div
    class="fixed inset-x-0 bottom-0 z-20 border-t border-dark-4 bg-dark-6/95 px-4 py-3 backdrop-blur"
  >
    <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
      <span class="text-sm font-semibold">{count} selected</span>
      <button onclick={() => selected.clear()} class="text-xs text-dark-2 hover:text-white">
        Clear
      </button>

      {#if skipped > 0}
        <span class="text-xs text-dark-2">{skipped} already removed: dismiss each on its card</span>
      {/if}

      <!-- Keyed on the selection: the tools and the reason picker hold what was set locally, and that
           state belongs to the batch it was set on, not to the next one.
           `null` throughout — a batch has no single current rating or flag to show as active. -->
      {#if verdictCount}
        {#key verdictImageIds}
          <ImageCardModTools
            imageIds={verdictImageIds}
            nsfwLevel={null}
            minor={null}
            poi={null}
            rating={!appeal}
          />
        {/key}
      {/if}

      <div class="ml-auto flex flex-wrap gap-2">
        {#if appeal}
          {@render bulkButton('?/bulkResolveAppeal', imageIds, `Approve ${count}`, 'border-emerald-600/40 text-emerald-400 hover:bg-emerald-500/10', { status: 'Approved' })}
          {@render bulkButton('?/bulkResolveAppeal', imageIds, `Reject ${count}`, 'border-rose-500/40 text-rose-400 hover:bg-rose-500/10', { status: 'Rejected' })}
        {:else if verdictCount}
          {@render bulkButton('?/bulkAccept', verdictImageIds, `${acceptLabel} ${verdictCount}`, 'border-teal-600/40 text-teal-400 hover:bg-teal-500/10')}
          {#if minorQueue}
            {@render bulkButton('?/bulkAccept', verdictImageIds, `Accept ${verdictCount} + clear minor`, 'border-cyan-600/40 text-cyan-400 hover:bg-cyan-500/10', { removeMinorFlag: 'true' })}
          {/if}
          {#key verdictImageIds}
            <TosDeleteButton
              action="?/bulkBlock"
              {submit}
              label={`Remove ${verdictCount}`}
              hidden={{ imageIds: verdictImageIds, reportIds }}
            />
          {/key}
        {/if}
      </div>
    </div>
  </div>
{/if}

{#snippet bulkButton(action: string, ids: string, label: string, cls: string, extra: Record<string, string> = {})}
  <form method="POST" {action} use:enhance={submit}>
    <input type="hidden" name="imageIds" value={ids} />
    <input type="hidden" name="reportIds" value={reportIds} />
    {#each Object.entries(extra) as [k, v] (k)}
      <input type="hidden" name={k} value={v} />
    {/each}
    <button type="submit" class="rounded border px-3 py-1 text-xs font-semibold transition {cls}">
      {label}
    </button>
  </form>
{/snippet}

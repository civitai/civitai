<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { SvelteSet } from 'svelte/reactivity';
  import RulingForm from '$lib/components/RulingForm.svelte';
  import SelectionBar from '$lib/components/SelectionBar.svelte';
  import { appealRulingChoices } from '$lib/ruling-choices';
  import ImageCardModTools from './ImageCardModTools.svelte';
  import TosDeleteButton from './TosDeleteButton.svelte';
  import TipButton from '$lib/components/TipButton.svelte';

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
  const acceptTip = $derived(
    reported
      ? 'Leave the selected images up and mark their reports Unactioned.'
      : 'Approve the selected images: they stay up and leave this queue.'
  );
</script>

<SelectionBar {count} onclear={() => selected.clear()}>
  {#snippet actions()}
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
        <!-- One reason for the whole batch, so the batch must be one kind of case. Keyed so a reason
             picked for one selection is not carried to the next. -->
        {#key imageIds}
          <RulingForm
            subject="appeal"
            choices={appealRulingChoices(count)}
            action="?/bulkResolveAppeal"
            enhancer={submit}
            idPrefix="bulk-appeal"
            size="xs"
          >
            {#snippet hidden()}
              <input type="hidden" name="imageIds" value={imageIds} />
            {/snippet}
          </RulingForm>
        {/key}
      {:else if verdictCount}
        {@render bulkButton('?/bulkAccept', verdictImageIds, `${acceptLabel} ${verdictCount}`, acceptTip, 'border-teal-600/40 text-teal-400 hover:bg-teal-500/10')}
        {#if minorQueue}
          {@render bulkButton('?/bulkAccept', verdictImageIds, `Accept ${verdictCount} + clear minor`, 'Approve the selected images and remove their minor flag.', 'border-cyan-600/40 text-cyan-400 hover:bg-cyan-500/10', { removeMinorFlag: 'true' })}
        {/if}
        {#key verdictImageIds}
          <TosDeleteButton
            action="?/bulkBlock"
            {submit}
            label={`Remove ${verdictCount}`}
            tip={reported
              ? 'Take the selected images down and mark their reports Actioned. You pick the reason next.'
              : 'Take the selected images down for a ToS violation. You pick the reason next.'}
            hidden={{ imageIds: verdictImageIds, reportIds }}
          />
        {/key}
      {/if}
    </div>
  {/snippet}
</SelectionBar>

{#snippet bulkButton(action: string, ids: string, label: string, tip: string, cls: string, extra: Record<string, string> = {})}
  <form method="POST" {action} use:enhance={submit}>
    <input type="hidden" name="imageIds" value={ids} />
    <input type="hidden" name="reportIds" value={reportIds} />
    {#each Object.entries(extra) as [k, v] (k)}
      <input type="hidden" name={k} value={v} />
    {/each}
    <TipButton {tip} type="submit" size="sm" variant="outline" class={cls}>
      {label}
    </TipButton>
  </form>
{/snippet}

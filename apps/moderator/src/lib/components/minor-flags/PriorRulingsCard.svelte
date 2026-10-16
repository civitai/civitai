<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { dateTime } from '$lib/format';
  import { ago, pastAppealsText } from '$lib/minor-flags/appeal-row';
  import {
    clearViaLabel,
    rulingText,
    type FlagRulingView,
    type PriorClearView,
  } from '$lib/minor-flags/text-scan-verdicts';

  let {
    granted,
    grantedByUsername,
    rulings,
    showPriorClear,
    showRulings,
    pastAppeals,
  }: {
    granted: PriorClearView | null;
    grantedByUsername: string | null;
    rulings: FlagRulingView[] | null;
    /** A first detection has no human clear behind it; its earlier rulings still show. */
    showPriorClear: boolean;
    showRulings: boolean;
    /** The uploader's earlier appeals, when the row carries them. */
    pastAppeals?: { approved: number; rejected: number; void: number; pending: number };
  } = $props();

  const listed = $derived(showRulings ? (rulings ?? []) : []);
  const empty = $derived(!showPriorClear && listed.length === 0 && !pastAppeals);
</script>

<TriageCard title="Prior rulings and appeals">
  <div class="space-y-1.5 text-base text-dark-0">
    {#if showPriorClear}
      <p class="m-0">
        {#if granted}
          Previously cleared: {clearViaLabel(granted.via)}
          {#if grantedByUsername}
            by <span class="font-medium text-white">{grantedByUsername}</span>
          {:else if granted.by}
            by user #{granted.by}
          {/if}
          {#if granted.at}
            <span class="text-sm text-dark-2" title={dateTime(granted.at)}>· {ago(granted.at)}</span>
          {/if}
        {:else}
          Previously cleared: no clearing record.
        {/if}
      </p>
    {/if}
    {#each listed as ruling, i (`${ruling.decision}:${ruling.at}:${ruling.by}:${i}`)}
      <p class="m-0">
        {rulingText(ruling.decision, ruling.via)}
        {#if ruling.by}by user #{ruling.by}{/if}
        {#if ruling.at}
          <span class="text-sm text-dark-2" title={dateTime(ruling.at)}>· {ago(ruling.at)}</span>
        {/if}
      </p>
    {/each}
    {#if pastAppeals}
      <p class="m-0">This uploader's earlier appeals: {pastAppealsText(pastAppeals)}.</p>
    {/if}
    {#if empty}
      <p class="m-0">No moderator has ruled on this model yet.</p>
    {/if}
  </div>
</TriageCard>

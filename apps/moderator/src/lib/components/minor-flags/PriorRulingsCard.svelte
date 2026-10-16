<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { dateTime } from '$lib/format';
  import { ago } from '$lib/minor-flags/appeal-row';
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
  }: {
    granted: PriorClearView | null;
    grantedByUsername: string | null;
    rulings: FlagRulingView[] | null;
    /** A first detection has no human clear behind it; its earlier rulings still show. */
    showPriorClear: boolean;
  } = $props();
</script>

{#if showPriorClear}
  <TriageCard title="Previously cleared">
    <div class="space-y-2 text-base text-dark-0">
      {#if granted}
        <p class="m-0">
          {clearViaLabel(granted.via)}
          {#if grantedByUsername}
            by <span class="font-medium text-white">{grantedByUsername}</span>
          {:else if granted.by}
            by user #{granted.by}
          {/if}
          {#if granted.at}
            <span class="text-sm text-dark-2" title={dateTime(granted.at)}>
              · {ago(granted.at)}
            </span>
          {/if}
        </p>
      {:else}
        <p class="m-0">No clearing record.</p>
      {/if}
    </div>
  </TriageCard>
{/if}

{#if rulings?.length}
  <TriageCard title="Earlier rulings">
    <div class="space-y-1 text-sm text-dark-0">
      {#each rulings as ruling, i (`${ruling.decision}:${ruling.at}:${ruling.by}:${i}`)}
        <p class="m-0">
          {rulingText(ruling.decision, ruling.via)}
          {#if ruling.by}by user #{ruling.by}{/if}
          {#if ruling.at}
            <span class="text-dark-2" title={dateTime(ruling.at)}>· {ago(ruling.at)}</span>
          {/if}
        </p>
      {/each}
    </div>
  </TriageCard>
{/if}

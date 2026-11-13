<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { dateTime } from '$lib/format';
  import {
    ago,
    pastAppealsText,
    sameFileAppealsText,
    type AppealCounts,
  } from '$lib/minor-flags/appeal-row';
  import {
    clearViaLabel,
    rulingText,
    type FlagRulingView,
    type PriorClearView,
  } from '$lib/minor-flags/text-scan-verdicts';

  let {
    title = 'Prior rulings and appeals',
    granted,
    grantedByUsername,
    rulings,
    showPriorClear,
    showRulings,
    pastAppeals,
    sameFileAppeals,
    appealOpen,
  }: {
    title?: string;
    granted: PriorClearView | null;
    grantedByUsername: string | null;
    rulings: FlagRulingView[] | null;
    /** A first detection has no human clear behind it; its earlier rulings still show. */
    showPriorClear: boolean;
    showRulings: boolean;
    /** The uploader's earlier appeals, when the row carries them. */
    pastAppeals?: AppealCounts;
    /** Appeals on other models sharing a file with this one, when the row carries them. */
    sameFileAppeals?: AppealCounts;
    /** Whether the owner has an appeal open on this model, when the row knows. */
    appealOpen?: boolean;
  } = $props();

  const listed = $derived(showRulings ? (rulings ?? []) : []);
  // Only a row that carries ruling history can say nobody has ruled; a null list means unknown.
  const none = $derived(
    showRulings && Array.isArray(rulings) && rulings.length === 0 && !showPriorClear
  );
  const sameFileAppealsLine = $derived(sameFileAppeals ? sameFileAppealsText(sameFileAppeals) : null);
  const visible = $derived(showPriorClear || listed.length > 0 || !!pastAppeals || !!sameFileAppealsLine || none);
</script>

{#if visible}
  <TriageCard dense {title}>
    <div class="space-y-1.5 text-dark-1">
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
      {#if none}
        <p class="m-0">
          No moderator has ruled on this model yet.{#if appealOpen === false}
            The owner has no open appeal.{/if}
        </p>
      {/if}
      {#if sameFileAppealsLine}
        <p class="m-0">Same file on other models: {sameFileAppealsLine}.</p>
      {/if}
      {#if pastAppeals}
        <p class="m-0">This uploader's earlier appeals: {pastAppealsText(pastAppeals)}.</p>
      {/if}
    </div>
  </TriageCard>
{/if}

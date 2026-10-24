<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { dateTime } from '$lib/format';
  import { ago } from '$lib/minor-flags/appeal-row';
  import { appealOrdinalText } from '$lib/minor-flags/model-detail';

  let {
    message,
    appealedAt,
    nthThisYear,
  }: {
    message: string | null;
    appealedAt: Date | string;
    /** This appeal's place among the uploader's model appeals this year. */
    nthThisYear: number;
  } = $props();

  const ordinal = $derived(appealOrdinalText(nthThisYear));
</script>

<TriageCard dense title="What the owner says">
  {#if message}
    <p class="m-0 break-words whitespace-pre-wrap text-dark-0">{message}</p>
  {:else}
    <p class="m-0 text-dark-0">The owner left no message.</p>
  {/if}
  <p class="m-0 mt-3 text-[11px] text-dark-2">
    <span title={dateTime(appealedAt)}>appealed {ago(appealedAt)}</span>{#if ordinal}
      · {ordinal}{/if}
  </p>
</TriageCard>

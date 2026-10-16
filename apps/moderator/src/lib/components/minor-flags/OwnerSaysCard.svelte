<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { dateTime } from '$lib/format';
  import { ago, waiting } from '$lib/minor-flags/appeal-row';

  let {
    message,
    appealedAt,
  }: { message: string | null; appealedAt: Date | string } = $props();
</script>

<TriageCard title="What the owner says">
  {#if message}
    <p class="m-0 text-base break-words whitespace-pre-wrap text-dark-0">{message}</p>
  {:else}
    <p class="m-0 text-base text-dark-0">The owner left no message.</p>
  {/if}
  <p class="m-0 mt-3 text-sm text-dark-2" title={dateTime(appealedAt)}>
    Appealed {ago(appealedAt)}, waiting {waiting(appealedAt)}
  </p>
</TriageCard>

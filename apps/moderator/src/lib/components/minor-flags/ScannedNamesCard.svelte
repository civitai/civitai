<script lang="ts">
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';

  let { names }: { names: readonly string[] } = $props();
</script>

<TriageCard title="Scanned text">
  <p class="m-0 mb-2 text-sm text-dark-2">What the scan matched in the model's text:</p>
  <div class="flex flex-wrap gap-1.5">
    {#each names as name, i (i)}
      <MetaChip tone="red" size="md">{name}</MetaChip>
    {/each}
  </div>
</TriageCard>

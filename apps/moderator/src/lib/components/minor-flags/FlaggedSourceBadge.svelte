<script lang="ts">
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import { detectionCopy, detectionKind } from '$lib/minor-flags/text-scan-verdicts';
  import type { FlaggedRow } from '$lib/server/minor-hash.service';

  let {
    row,
    size = 'sm',
  }: { row: Pick<FlaggedRow, 'source' | 'redetected'>; size?: 'sm' | 'md' } = $props();

  const kind = $derived(
    row.source === 'redetected' && row.redetected ? detectionKind(row.redetected) : null
  );
</script>

{#if kind}
  <MetaChip {size} tone={kind === 'first' ? 'violet' : 'amber'}>
    {detectionCopy(kind).badge.toLowerCase()}
  </MetaChip>
{:else}
  <MetaChip {size} tone="blue">hash</MetaChip>
{/if}

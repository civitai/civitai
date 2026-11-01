<script lang="ts">
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import { detectionKind } from '$lib/minor-flags/text-scan-verdicts';
  import type { FlaggedFlagItem } from '$lib/server/minor-hash.service';

  /** What raised a flag or lead. A file match reads "hash": the same sweep, nothing applied yet. */
  let { row }: { row: Pick<FlaggedFlagItem, 'source' | 'redetected'> } = $props();

  const kind = $derived(
    row.source === 'redetected' && row.redetected ? detectionKind(row.redetected) : null
  );
</script>

{#if kind}
  <MetaChip tone="violet">
    text scan · {kind === 'first' ? 'first detection' : 're-detection'}
  </MetaChip>
{:else if row.source === 'text-scan'}
  <MetaChip tone="violet">text-scan</MetaChip>
{:else}
  <MetaChip tone="blue">hash</MetaChip>
{/if}

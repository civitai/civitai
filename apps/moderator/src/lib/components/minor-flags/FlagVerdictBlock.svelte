<script lang="ts">
  import type { Snippet } from 'svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import type { FlagLabel } from '$lib/minor-flags/text-scan-verdicts';

  /** One label's verdict in a "Why it was flagged" (or "detected") card: label and chip, the reason,
   *  where it came from. */
  let {
    label,
    reason,
    provenance,
    applied = true,
    children,
  }: {
    label: FlagLabel;
    /** False for a held detection: the scan found it but no flag was applied. */
    applied?: boolean;
    reason: string | null | undefined;
    provenance: Snippet;
    /** Notes under the provenance line (a later scan that disagrees, an appeal). */
    children?: Snippet;
  } = $props();
</script>

<div class="space-y-[3px]">
  <div class="flex items-center gap-1.5">
    <span class="text-[13px] font-semibold text-white">{label === 'poi' ? 'real person' : 'minor'}</span>
    {#if applied}
      <MetaChip tone="red">Flagged</MetaChip>
    {:else}
      <MetaChip tone="neutral">Detected, not applied</MetaChip>
    {/if}
  </div>
  <p class="m-0 text-[13px] leading-[1.45] text-dark-0">{reason || 'No reason recorded.'}</p>
  <p class="m-0 text-[11px] text-dark-2">{@render provenance()}</p>
  {@render children?.()}
</div>

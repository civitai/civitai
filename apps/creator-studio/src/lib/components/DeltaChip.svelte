<script lang="ts">
  import { IconArrowUpRight, IconArrowDownRight } from '@tabler/icons-svelte';
  import { pctChange } from '$lib/date-range';

  // Period-over-period change chip. `previous` null/undefined (no prior data loaded) renders nothing, so a failed
  // comparison fetch just hides the chip rather than breaking the tile. Higher is treated as better (green up) —
  // valid for every metric we attach this to (counts, buzz earned).
  let {
    current,
    previous,
    label = 'vs previous period',
  }: { current: number; previous: number | null | undefined; label?: string } = $props();

  const pct = $derived(previous == null ? null : pctChange(current, previous));
</script>

{#if pct != null && Math.round(pct) !== 0}
  {@const up = pct > 0}
  <span
    class="inline-flex items-center gap-0.5 text-xs font-medium {up ? 'text-green-5' : 'text-red-5'}"
    title="{up ? '+' : ''}{Math.round(pct)}% {label}"
  >
    {#if up}<IconArrowUpRight size={12} />{:else}<IconArrowDownRight size={12} />{/if}
    {Math.abs(Math.round(pct))}%
  </span>
{:else if previous === 0 && current > 0}
  <span class="text-xs font-medium text-green-5" title="No activity in the previous period">new</span>
{/if}

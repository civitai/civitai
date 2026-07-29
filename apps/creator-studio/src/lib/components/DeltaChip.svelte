<script lang="ts">
  import { IconArrowUpRight, IconArrowDownRight } from '@tabler/icons-svelte';
  import { pctChange } from '$lib/date-range';

  // Period-over-period change chip. Renders nothing when there's no baseline to compare against — `previous`
  // null/undefined (comparison not loaded) OR 0 (no activity in the prior period): "% of zero" is undefined, so
  // we omit it rather than show a misleading badge. Higher is treated as better (green up).
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
{/if}

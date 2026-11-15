<script lang="ts">
  import RangeSelector from '$lib/components/RangeSelector.svelte';
  import type { Snippet } from 'svelte';
  import type { DateRange } from '$lib/date-range';

  // Shared analytics header. Each page renders it with what it needs: pass `range`/`compare` to show the period
  // picker (omit for all-time pages like Engagement); `showCompare={false}` for month-only pages (Images/Videos).
  let {
    range,
    compare,
    showCompare = true,
    children,
  }: {
    range?: DateRange;
    compare?: { key: string; label: string };
    showCompare?: boolean;
    children?: Snippet;
  } = $props();
</script>

<header class="page-header flex flex-wrap items-start gap-3">
  <div>
    <h1>Analytics</h1>
    <p>Your content and model performance.</p>
  </div>
  {#if children || (range && compare)}
    <div class="ml-auto flex flex-wrap items-center justify-end gap-2">
      {@render children?.()}
      {#if range && compare}
        <RangeSelector {range} {compare} {showCompare} />
      {/if}
    </div>
  {/if}
</header>

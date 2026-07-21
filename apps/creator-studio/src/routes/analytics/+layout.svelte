<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import RangeSelector from '$lib/components/RangeSelector.svelte';
  import type { LayoutData } from './$types';

  // Shared header + range for every analytics sub-page; the sub-page nav lives in the sidebar (see $lib/nav).
  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  // Engagement is all-time only (no dated source for model votes/comments) — hide the month range there so it
  // doesn't imply filtering.
  const showRange = $derived(page.url.pathname !== '/analytics/engagement');
</script>

<header class="page-header flex flex-wrap items-start gap-3">
  <div>
    <h1>Analytics</h1>
    <p>Your content and model performance.</p>
  </div>
  {#if showRange}
    <div class="ml-auto">
      <RangeSelector range={data.range} compare={data.compare} />
    </div>
  {/if}
</header>

{@render children()}

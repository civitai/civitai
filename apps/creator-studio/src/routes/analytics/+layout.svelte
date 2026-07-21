<script lang="ts">
  import type { Snippet } from 'svelte';
  import RangeSelector from '$lib/components/RangeSelector.svelte';
  import type { LayoutData } from './$types';

  // Shared header + range for every analytics sub-page; the sub-page nav lives in the sidebar (see $lib/nav).
  let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<header class="page-header flex flex-wrap items-start gap-3">
  <div>
    <h1>Analytics</h1>
    <p>Your content and model performance.</p>
  </div>
  <div class="ml-auto">
    <RangeSelector range={data.range} compare={data.compare} />
  </div>
</header>

{@render children()}

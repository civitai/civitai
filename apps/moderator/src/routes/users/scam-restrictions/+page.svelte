<script lang="ts">
  import RestrictionQueue from '$lib/components/restrictions/RestrictionQueue.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<header class="page-header">
  <h1>Scam Restrictions</h1>
  <p>Accounts flagged for scam activity, and the rulings on them.</p>
</header>

<RestrictionQueue {data} />

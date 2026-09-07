<script lang="ts">
  import { goto } from '$app/navigation';
  import AppHeader from '$lib/components/AppHeader.svelte';
  import TrainingFlow from '../TrainingFlow.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<AppHeader username={data.username} image={data.image} logoutUrl={data.logoutUrl} buzz={data.buzz} />

<!-- Usually resolved before the user reaches here (warm cache); the await gates only on a cold cache, and
  never rejects. -->
{#await data.fromPrices}
  <div class="grid place-items-center py-20 font-mono text-sm text-dark-2">Loading pricing…</div>
{:then prices}
  <TrainingFlow {prices} onExit={() => goto('/')} />
{:catch}
  <TrainingFlow prices={{}} onExit={() => goto('/')} />
{/await}

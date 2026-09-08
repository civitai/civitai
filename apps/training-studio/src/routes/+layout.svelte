<script lang="ts">
  import '../global.css';
  import { onMount } from 'svelte';
  import { connectSignals, onSignal } from '$lib/signals';
  import { BUZZ_UPDATE_SIGNAL } from '$lib/signal-events';
  import { buzzBalance } from '$lib/buzz-balance.svelte';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  // Open the shared signals connection once per tab and keep the header balance live: a `buzz:update` fires
  // whenever the user spends or earns, so we re-read the authoritative balance. Best-effort — everything
  // still works on polling if signals never connect.
  onMount(() => {
    if (!data.signalsEnabled) return;
    buzzBalance.seed(data.buzz);
    connectSignals();
    return onSignal(BUZZ_UPDATE_SIGNAL, () => buzzBalance.refresh());
  });
</script>

<div class="mx-auto w-full max-w-6xl overflow-x-hidden px-6 py-10">
  {@render children()}
</div>

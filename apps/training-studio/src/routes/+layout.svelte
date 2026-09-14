<script lang="ts">
  import '../global.css';
  import { onMount } from 'svelte';
  import { goto, invalidate } from '$app/navigation';
  import { env } from '$env/dynamic/public';
  import { setHostContext, type StudioLocation } from '$lib/host';
  import { shellBackend } from '$lib/shell-backend';
  import { connectSignals, onSignal } from '$lib/signals';
  import { BUZZ_UPDATE_SIGNAL } from '$lib/signal-events';
  import { buzzBalance } from '$lib/buzz-balance.svelte';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  // The shell half of the host seam ($lib/host): flow code never touches $app/$env or a URL path itself,
  // so it can be rehosted as a web component whose wrapper sets a different context. Runs during init
  // (not onMount) so SSR renders (avatar URLs) resolve through it too.
  const hrefFor = (loc: StudioLocation) =>
    loc.view === 'home' ? '/' : loc.view === 'new' ? '/new' : `/${loc.workflowId}`;
  setHostContext({
    backend: shellBackend,
    config: {
      imageLocation: env.PUBLIC_IMAGE_LOCATION || null,
      signalsEndpoint: env.PUBLIC_SIGNALS_ENDPOINT || null,
    },
    hrefFor,
    navigate: (loc, opts) => goto(hrefFor(loc), opts?.refreshAll ? { invalidateAll: true } : undefined),
    refresh: (key) => invalidate(key),
  });

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

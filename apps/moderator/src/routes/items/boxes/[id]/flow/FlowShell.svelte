<script lang="ts">
  import { untrack } from 'svelte';
  import { EMPTY_FILTERS } from '$lib/box-design';
  import { DEFAULT_BANDS, isPriceTiering } from '$lib/box-flow';
  import { LINK_CLASS } from '$lib/format';
  import BoxFlow from './BoxFlow.svelte';
  import type { FlowUi } from './ui-state';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // An event box starts on its own event's cosmetics.
  let ui = $state<FlowUi>(
    untrack(() => ({
      step: 'basics',
      bands: { ...DEFAULT_BANDS },
      preset: isPriceTiering(data.draft.tiers) ? 'price' : 'custom',
      itemsTab: 'catalog',
      filters: { ...EMPTY_FILTERS, event: data.draft.event },
      hideInBox: false,
    }))
  );
</script>

<header class="page-header">
  <h1>#{data.box.id} {data.draft.name}</h1>
  <span class="flex gap-3 text-sm">
    <a class={LINK_CLASS} href="/items/boxes/{data.box.id}/openings">Openings</a>
    <a class={LINK_CLASS} href="/items/boxes/{data.box.id}">Old editor</a>
  </span>
</header>

<!-- Remounts BoxFlow on every write so its working copy restarts from the server's rows (new ids). `ui` lives here to survive that. -->
{#key `${data.box.version}:${data.box.updatedAt}`}
  <BoxFlow
    box={data.box}
    initial={data.draft}
    initialRewards={data.rewards}
    events={data.events}
    snapshots={data.snapshots}
    listings={data.listings}
    civitaiUrl={data.civitaiUrl}
    canDefine={data.canDefine}
    bind:ui
    onpublished={() => (ui.step = 'sell')}
  />
{/key}

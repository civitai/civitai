<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Toggle } from '@civitai/ui/components/ui/toggle/index.js';
  import type { FlowReward } from '$lib/box-design';
  import type { PriceBands, TeamOdds, TierPreset } from '$lib/box-flow';
  import type { BoxDraft } from '$lib/mystery-box';
  import CatalogPanel from './CatalogPanel.svelte';
  import OddsTable from './OddsTable.svelte';
  import TierTray from './TierTray.svelte';

  let {
    draft = $bindable(),
    rewards,
    events,
    odds,
    bands = $bindable(),
    preset = $bindable(),
    focusTier = $bindable(),
    tab = $bindable(),
    boxId,
    dockHeight,
  }: {
    draft: BoxDraft;
    rewards: SvelteMap<number, FlowReward>;
    events: { event: string; teams: string[] }[];
    odds: TeamOdds[];
    bands: PriceBands;
    preset: TierPreset;
    focusTier: string | null;
    /** Below the xl breakpoint the catalog and the box take turns; above it they sit side by side. */
    tab: 'catalog' | 'box';
    boxId: number;
    dockHeight: number;
  } = $props();
</script>

<div class="mb-3 grid grid-cols-2 gap-2 xl:hidden">
  <Toggle variant="outline" pressed={tab === 'catalog'} onPressedChange={() => (tab = 'catalog')}>Pick items</Toggle>
  <Toggle variant="outline" pressed={tab === 'box'} onPressedChange={() => (tab = 'box')}>
    Your box <Badge variant="outline">{draft.contents.length}</Badge>
  </Toggle>
</div>

<div class="gap-4 xl:grid xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,1fr)] xl:items-start">
  <div class={tab === 'box' ? 'hidden xl:block' : ''}>
    <CatalogPanel bind:draft {rewards} {events} {bands} {boxId} {dockHeight} />
  </div>
  <div
    class="space-y-3 xl:sticky xl:top-2 xl:overflow-y-auto {tab === 'catalog' ? 'hidden xl:block' : ''}"
    style:max-height="calc(100vh - {dockHeight}px - 1rem)"
  >
    <TierTray bind:draft {rewards} {odds} bind:bands bind:preset bind:focusTier />
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-4">
      <h2 class="mb-1 text-base font-semibold text-white">Odds by team</h2>
      <p class="mb-3 text-xs text-dark-2">
        For a buyer who owns none of it, through the draw's own odds. Teams show as one column while they match.
      </p>
      <OddsTable {odds} />
    </section>
  </div>
</div>

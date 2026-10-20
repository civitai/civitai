<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import type { CosmeticEvent, FlowReward } from '$lib/box-design';
  import type { TeamOdds } from '$lib/box-flow';
  import type { BoxDraft } from '$lib/mystery-box';
  import CatalogPanel from './CatalogPanel.svelte';
  import Chip from './Chip.svelte';
  import OddsTable from './OddsTable.svelte';
  import TierTray from './TierTray.svelte';
  import type { FlowUi } from './ui-state';

  let {
    draft = $bindable(),
    ui = $bindable(),
    rewards,
    events,
    odds,
    focusTier = $bindable(),
    boxId,
    dockHeight,
    canDefine,
  }: {
    draft: BoxDraft;
    ui: FlowUi;
    rewards: SvelteMap<number, FlowReward>;
    events: CosmeticEvent[];
    odds: TeamOdds[];
    /** A tier to scroll to and flash, set by the checklist's Fix buttons. */
    focusTier: string | null;
    boxId: number;
    dockHeight: number;
    canDefine: boolean;
  } = $props();
</script>

<div class="mb-3 grid grid-cols-2 gap-2 xl:hidden">
  <Chip size="default" pressed={ui.itemsTab === 'catalog'} onclick={() => (ui.itemsTab = 'catalog')}>Pick items</Chip>
  <Chip size="default" pressed={ui.itemsTab === 'box'} onclick={() => (ui.itemsTab = 'box')}>
    Your box <Badge variant="outline">{draft.contents.length}</Badge>
  </Chip>
</div>

<div class="gap-4 xl:grid xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,1fr)] xl:items-start">
  <div class={ui.itemsTab === 'box' ? 'hidden xl:block' : ''}>
    <CatalogPanel bind:draft bind:filters={ui.filters} bind:hideInBox={ui.hideInBox} {rewards} {events} bands={ui.bands} {boxId} {dockHeight} {canDefine} />
  </div>
  <div
    class="space-y-3 xl:sticky xl:top-2 xl:overflow-y-auto {ui.itemsTab === 'catalog' ? 'hidden xl:block' : ''}"
    style:max-height="calc(100vh - {dockHeight}px - 1rem)"
  >
    <TierTray bind:draft {rewards} {odds} bind:bands={ui.bands} bind:preset={ui.preset} bind:focusTier />
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <h2 class="mb-1 text-base font-semibold text-white">Odds by team</h2>
      <p class="mb-3 text-xs text-dark-2">
        For a buyer who owns none of it, through the draw's own odds. Teams show as one column while they match.
      </p>
      <OddsTable {odds} />
    </section>
  </div>
</div>

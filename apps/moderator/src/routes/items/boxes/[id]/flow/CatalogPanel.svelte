<script lang="ts">
  import { browser } from '$app/environment';
  import { SvelteMap } from 'svelte/reactivity';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { num } from '$lib/format';
  import { keepLast } from '$lib/keep-last.svelte';
  import {
    catalogParams,
    CATALOG_MAX,
    CATALOG_PAGE,
    EMPTY_FILTERS,
    isDefined,
    type CatalogDesign,
    type CatalogFilters,
    type CosmeticEvent,
    type FlowReward,
  } from '$lib/box-design';
  import { definitionIds, placeDesigns, presenceOf, removeRewards, type PriceBands } from '$lib/box-flow';
  import type { BoxDraft } from '$lib/mystery-box';
  import { fetchCatalog } from './catalog';
  import CatalogFiltersBar from './CatalogFilters.svelte';
  import DesignCard from './DesignCard.svelte';
  import { notify } from './notify';
  import SelectionBar from './SelectionBar.svelte';

  let {
    draft = $bindable(),
    filters = $bindable(),
    hideInBox = $bindable(),
    rewards,
    events,
    bands,
    boxId,
    dockHeight,
    canDefine,
  }: {
    draft: BoxDraft;
    filters: CatalogFilters;
    hideInBox: boolean;
    rewards: SvelteMap<number, FlowReward>;
    events: CosmeticEvent[];
    bands: PriceBands;
    boxId: number;
    dockHeight: number;
    canDefine: boolean;
  } = $props();

  const TYPE_LABELS: Record<string, string> = {
    ContentDecoration: 'Decoration',
    Badge: 'Badge',
    ProfileDecoration: 'Frame',
    ProfileBackground: 'Background',
    Sticker: 'Sticker',
    NamePlate: 'Name plate',
    CardDecoration: 'Card decoration',
    ChatTheme: 'Chat theme',
  };

  let refreshed = $state(0);
  /** Selected designs by key, as they were when picked. */
  const selected = new SvelteMap<string, CatalogDesign>();

  const query = $derived(`${catalogParams(filters, bands)}&v=${refreshed}`);
  const catalog = keepLast(() => (browser ? fetchCatalog(boxId, query) : null));

  const byReward = $derived(new Map(draft.contents.map((content) => [content.rewardDefinitionId, content])));
  const eligible = (design: CatalogDesign) => !design.event || design.event === draft.event;
  const designs = $derived(
    (catalog.value?.designs ?? []).filter((design) => !(hideInBox && presenceOf(design, byReward).inBox > 0))
  );
  const total = $derived(catalog.value?.total ?? 0);
  const tierOf = (key: string) => draft.tiers.find((tier) => tier.key === key);

  /** The selection as the latest catalog read has it, so a design defined a moment ago counts as defined. */
  const current = $derived.by(() => {
    const fresh = new Map((catalog.value?.designs ?? []).map((design) => [design.key, design]));
    return [...selected.entries()].map(([key, design]) => fresh.get(key) ?? design);
  });
  const pending = $derived(current.filter((design) => eligible(design) && !isDefined(design)));
  const pendingCosmeticIds = $derived(
    pending.flatMap((design) => design.variants.filter((variant) => variant.definitionId === null).map((variant) => variant.cosmeticId))
  );
  const inBoxCount = $derived(current.filter((design) => presenceOf(design, byReward).inBox > 0).length);

  function place(tierKey: string) {
    const picks = current.filter((design) => eligible(design) && isDefined(design));
    const result = placeDesigns(draft.contents, picks, tierKey);
    draft.contents = result.contents;
    for (const reward of result.rewards) rewards.set(reward.id, reward);
    const skipped = selected.size - picks.length;
    selected.clear();
    notify(
      `${result.added} added, ${result.moved} moved to ${tierOf(tierKey)?.name || tierKey}` +
        (skipped ? `; ${skipped} skipped (needs a definition or the box's event)` : '')
    );
  }

  function remove() {
    draft.contents = removeRewards(draft.contents, definitionIds(current));
    selected.clear();
  }

  const defining = new FormState({
    onSuccess: (data) => {
      const made = (data?.defined as { created: number } | undefined)?.created ?? 0;
      // A defined design is no longer what this selection held: pick it again from the refreshed list.
      for (const design of pending) selected.delete(design.key);
      refreshed += 1;
      notify(`${made} definition${made === 1 ? '' : 's'} created. Select those designs again to add them.`);
    },
    reload: false,
    reset: false,
  });
</script>

<CatalogFiltersBar bind:filters bind:hideInBox {events} {bands} />

<div class="mt-4 mb-2 flex flex-wrap items-center justify-between gap-2">
  <span class="text-sm text-dark-2" aria-live="polite">
    {#if catalog.value}{designs.length} shown of {num(total)} {total === 1 ? 'design' : 'designs'}{:else if catalog.failed}Could not load{:else}Loading the catalog…{/if}
    {#if catalog.loading && catalog.value}<span class="ml-1">updating…</span>{/if}
  </span>
  <Button size="sm" variant="outline" disabled={designs.length === 0} onclick={() => designs.forEach((design) => eligible(design) && selected.set(design.key, design))}>
    Select all shown
  </Button>
</div>

{#if catalog.failed}
  <div class="mb-2 flex items-center gap-2">
    <ErrorAlert class="flex-1" message="The catalog could not be loaded. {catalog.value ? 'These are the last results.' : ''}" />
    <Button size="sm" variant="outline" onclick={() => (refreshed += 1)}>Retry</Button>
  </div>
{/if}

{#if catalog.value && designs.length === 0}
  <div class="rounded-xl border border-dark-4 p-6 text-center text-sm text-dark-2">
    Nothing matches these filters.
    <Button size="sm" variant="outline" class="ml-2" onclick={() => { filters = { ...EMPTY_FILTERS }; hideInBox = false; }}>Clear filters</Button>
  </div>
{:else}
  <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" style:padding-bottom="{selected.size ? 96 : 0}px">
    {#each designs as design (design.key)}
      {@const where = presenceOf(design, byReward)}
      <DesignCard
        {design}
        selected={selected.has(design.key)}
        eligible={eligible(design)}
        inBox={where.inBox}
        tier={where.tierKeys.length === 1 ? tierOf(where.tierKeys[0]) : undefined}
        typeLabel={TYPE_LABELS[design.type] ?? design.type}
        onclick={() => (selected.has(design.key) ? selected.delete(design.key) : selected.set(design.key, design))}
      />
    {/each}
  </div>
  {#if catalog.value && catalog.value.designs.length < total}
    <div class="mt-3 text-center">
      {#if filters.limit >= CATALOG_MAX}
        <span class="text-sm text-dark-2">Showing the first {CATALOG_MAX}. Narrow the search to see the rest.</span>
      {:else}
        <Button variant="outline" onclick={() => (filters = { ...filters, limit: filters.limit + CATALOG_PAGE })}>Show more</Button>
      {/if}
    </div>
  {/if}
{/if}

{#if selected.size}
  <SelectionBar
    count={selected.size}
    inBox={inBoxCount}
    {pendingCosmeticIds}
    tiers={draft.tiers}
    {canDefine}
    {defining}
    {dockHeight}
    onplace={place}
    onremove={remove}
    onclear={() => selected.clear()}
  />
{/if}

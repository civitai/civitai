<script lang="ts">
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Toggle } from '@civitai/ui/components/ui/toggle/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { notify } from './notify';
  import { num } from '$lib/format';
  import { keepLast } from '$lib/keep-last.svelte';
  import {
    catalogParams,
    CATALOG_PAGE,
    EMPTY_FILTERS,
    isDefined,
    NO_EVENT,
    type CatalogDesign,
    type CatalogFilters,
    type FlowReward,
    type ShelfBand,
  } from '$lib/box-design';
  import { addDesigns, moveRewards, presenceOf, type PriceBands } from '$lib/box-flow';
  import type { BoxDraft } from '$lib/mystery-box';
  import { teamColor } from './teams';

  let {
    draft = $bindable(),
    rewards,
    events,
    bands,
    boxId,
    dockHeight,
  }: {
    draft: BoxDraft;
    rewards: SvelteMap<number, FlowReward>;
    events: { event: string; teams: string[] }[];
    bands: PriceBands;
    boxId: number;
    /** Where the selection bar sits: just above the dock. */
    dockHeight: number;
  } = $props();

  const TYPES = [
    ['ContentDecoration', 'Decoration'],
    ['Badge', 'Badge'],
    ['ProfileDecoration', 'Frame'],
    ['ProfileBackground', 'Background'],
    ['Sticker', 'Sticker'],
    ['NamePlate', 'Name plate'],
    ['CardDecoration', 'Card decoration'],
    ['ChatTheme', 'Chat theme'],
  ] as const;
  const typeLabel = (type: string) => TYPES.find(([key]) => key === type)?.[1] ?? type;
  const MAX = 480;

  // An event box starts on its own event's cosmetics.
  let filters = $state<CatalogFilters>({ ...EMPTY_FILTERS, event: untrack(() => draft.event) });
  let showFilters = $state(false);
  let hideInBox = $state(false);
  let refreshed = $state(0);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  /** Selected designs by key, holding the design as it was when picked. */
  const selected = new SvelteMap<string, CatalogDesign>();

  /** A filter change starts the list over at one page. */
  const filter = (patch: Partial<CatalogFilters>) => (filters = { ...filters, ...patch, limit: CATALOG_PAGE });
  const onSearch = (event: Event & { currentTarget: HTMLInputElement }) => {
    const value = event.currentTarget.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => filter({ q: value }), 250);
  };

  const query = $derived(`${catalogParams(filters, bands)}&v=${refreshed}`);
  const catalog = keepLast(() =>
    browser
      ? fetch(`/items/boxes/${boxId}/catalog?${query}`).then(async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          return (await response.json()) as { designs: CatalogDesign[]; total: number };
        })
      : null
  );

  const byReward = $derived(new Map(draft.contents.map((content) => [content.rewardDefinitionId, content])));
  const eligible = (design: CatalogDesign) => !design.event || design.event === draft.event;
  const designs = $derived(
    (catalog.value?.designs ?? []).filter((design) => !(hideInBox && presenceOf(design, byReward).inBox > 0))
  );
  const total = $derived(catalog.value?.total ?? 0);
  const tierOf = (key: string) => draft.tiers.find((tier) => tier.key === key);

  const activeTeams = $derived(
    filters.event && filters.event !== NO_EVENT
      ? (events.find((entry) => entry.event === filters.event)?.teams ?? [])
      : [...new Set(events.flatMap((entry) => entry.teams))].sort()
  );
  const activeFilters = $derived(
    (filters.event ? 1 : 0) + filters.types.length + (filters.team ? 1 : 0) + (filters.band ? 1 : 0) + (filters.needsDefinition ? 1 : 0)
  );

  const bandLabels = $derived<[ShelfBand, string][]>([
    ['', 'Any'],
    ['uncommon', `Up to ${num(bands.uncommon)}`],
    ['rare', `${num(bands.uncommon + 1)} to ${num(bands.rare)}`],
    ['legendary', `Over ${num(bands.rare)}`],
    ['none', 'No shelf price'],
  ]);

  function toggle(design: CatalogDesign) {
    if (selected.has(design.key)) selected.delete(design.key);
    else selected.set(design.key, design);
  }

  /** What the selection becomes once the catalog has been refetched, so a just-created definition counts. */
  const current = () => {
    const fresh = new Map((catalog.value?.designs ?? []).map((design) => [design.key, design]));
    return [...selected.entries()].map(([key, design]) => fresh.get(key) ?? design);
  };
  const pending = $derived(current().filter((design) => eligible(design) && !isDefined(design)));
  const pendingCosmeticIds = $derived(
    pending.flatMap((design) => design.variants.filter((variant) => variant.definitionId === null).map((variant) => variant.cosmeticId))
  );
  const inBoxCount = $derived(current().filter((design) => presenceOf(design, byReward).inBox > 0).length);

  function place(tierKey: string) {
    const picks = current().filter((design) => eligible(design) && isDefined(design));
    const ids = new Set(
      picks.flatMap((design) => design.variants.flatMap((variant) => (variant.definitionId === null ? [] : [variant.definitionId])))
    );
    const before = draft.contents.length;
    const moved = moveRewards(draft.contents, ids, tierKey);
    const added = addDesigns(moved.contents, picks, tierKey);
    draft.contents = added.contents;
    for (const reward of added.rewards) rewards.set(reward.id, reward);
    const skipped = selected.size - picks.length;
    selected.clear();
    const tier = tierOf(tierKey);
    notify(
      `${added.contents.length - before} added, ${moved.moved} moved to ${tier?.name || tierKey}` +
        (skipped ? `; ${skipped} skipped (needs a definition or the box's event)` : '')
    );
  }

  function remove() {
    const ids = new Set(
      current().flatMap((design) => design.variants.flatMap((variant) => (variant.definitionId === null ? [] : [variant.definitionId])))
    );
    draft.contents = draft.contents.filter((content) => !ids.has(content.rewardDefinitionId));
    selected.clear();
  }

  const defining = new FormState({
    onSuccess: (data) => {
      refreshed += 1;
      const made = (data?.defined as { created: number } | undefined)?.created ?? 0;
      notify(`${made} definition${made === 1 ? '' : 's'} created. They can be added now.`);
    },
    reload: false,
    reset: false,
  });
</script>

<div class="rounded-xl border border-dark-4 bg-dark-6 p-4">
  <div class="flex items-center gap-2">
    <Input
      type="search"
      class="flex-1"
      placeholder="Search cosmetics by name"
      aria-label="Search cosmetics by name"
      value={filters.q}
      oninput={onSearch}
    />
    <Button variant="outline" class="xl:hidden" aria-expanded={showFilters} onclick={() => (showFilters = !showFilters)}>
      Filters{activeFilters ? ` · ${activeFilters}` : ''}
    </Button>
  </div>

  <div class="mt-3 gap-x-6 gap-y-3 xl:grid xl:grid-cols-2 {showFilters ? 'grid' : 'hidden xl:grid'}">
    <div>
      <div class="mb-1 text-xs tracking-wide text-dark-3 uppercase">Event</div>
      <div class="flex flex-wrap gap-1.5">
        <Toggle size="sm" variant="outline" pressed={filters.event === ''} onPressedChange={() => filter({ event: '', team: '' })}>All</Toggle>
        {#each events as { event } (event)}
          <Toggle size="sm" variant="outline" pressed={filters.event === event} onPressedChange={() => filter({ event: filters.event === event ? '' : event, team: '' })}>{event}</Toggle>
        {/each}
        <Toggle size="sm" variant="outline" pressed={filters.event === NO_EVENT} onPressedChange={() => filter({ event: filters.event === NO_EVENT ? '' : NO_EVENT, team: '' })}>No event</Toggle>
      </div>
    </div>
    <div>
      <div class="mb-1 text-xs tracking-wide text-dark-3 uppercase">Type</div>
      <div class="flex flex-wrap gap-1.5">
        {#each TYPES as [type, label] (type)}
          <Toggle
            size="sm"
            variant="outline"
            pressed={filters.types.includes(type)}
            onPressedChange={() => filter({ types: filters.types.includes(type) ? filters.types.filter((t) => t !== type) : [...filters.types, type] })}
          >{label}</Toggle>
        {/each}
      </div>
    </div>
    {#if activeTeams.length}
      <div>
        <div class="mb-1 text-xs tracking-wide text-dark-3 uppercase">Made for team</div>
        <div class="flex flex-wrap gap-1.5">
          <Toggle size="sm" variant="outline" pressed={filters.team === ''} onPressedChange={() => filter({ team: '' })}>Any</Toggle>
          {#each activeTeams as team (team)}
            <Toggle size="sm" variant="outline" pressed={filters.team === team} onPressedChange={() => filter({ team: filters.team === team ? '' : team })}>
              <span class="size-2 rounded-full" style:background-color={teamColor(team)}></span>{team}
            </Toggle>
          {/each}
        </div>
      </div>
    {/if}
    <div>
      <div class="mb-1 text-xs tracking-wide text-dark-3 uppercase">Shelf price (Buzz)</div>
      <div class="flex flex-wrap gap-1.5">
        {#each bandLabels as [band, label] (band)}
          <Toggle size="sm" variant="outline" pressed={filters.band === band} onPressedChange={() => filter({ band })}>{label}</Toggle>
        {/each}
      </div>
    </div>
    <div>
      <div class="mb-1 text-xs tracking-wide text-dark-3 uppercase">Show</div>
      <div class="flex flex-wrap gap-1.5">
        <Toggle size="sm" variant="outline" pressed={hideInBox} onPressedChange={(on) => (hideInBox = on)}>Not in the box</Toggle>
        <Toggle size="sm" variant="outline" pressed={filters.needsDefinition} onPressedChange={(on) => filter({ needsDefinition: on })}>Needs a definition</Toggle>
      </div>
    </div>
  </div>
</div>

<div class="mt-4 mb-2 flex flex-wrap items-center justify-between gap-2">
  <span class="text-sm text-dark-2" aria-live="polite">
    {#if catalog.value}{designs.length} shown of {num(total)} {total === 1 ? 'design' : 'designs'}{:else}Loading…{/if}
    {#if catalog.loading && catalog.value}<span class="ml-1 text-dark-3">updating…</span>{/if}
  </span>
  <Button size="sm" variant="outline" disabled={designs.length === 0} onclick={() => designs.forEach((design) => eligible(design) && selected.set(design.key, design))}>
    Select all shown
  </Button>
</div>

{#if catalog.failed}
  <ErrorAlert class="mb-2" message="The catalog could not be loaded. {catalog.value ? 'These are the last results.' : 'Try again.'}" />
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
      {@const tier = where.tierKeys.length === 1 ? tierOf(where.tierKeys[0]) : undefined}
      {@const ok = eligible(design)}
      {@const image = design.variants.find((variant) => variant.url)?.url}
      <button
        type="button"
        class="flex min-w-0 flex-col gap-1.5 rounded-lg border bg-dark-7 p-2 text-left transition-colors hover:border-dark-3 disabled:cursor-not-allowed disabled:opacity-40 {selected.has(design.key) ? 'border-blue-5 bg-blue-9/20' : 'border-dark-4'}"
        aria-pressed={selected.has(design.key)}
        disabled={!ok}
        onclick={() => toggle(design)}
      >
        <span class="relative block aspect-square overflow-hidden rounded-md border border-dark-5 bg-dark-9">
          {#if image}
            <EdgeMedia src={image} width={240} alt="" class="size-full object-contain" />
          {:else}
            <span class="grid size-full place-items-center text-xs text-dark-3">no image</span>
          {/if}
          <span class="absolute top-1.5 left-1.5 grid size-5 place-items-center rounded border text-xs text-white {selected.has(design.key) ? 'border-blue-5 bg-blue-5' : 'border-dark-3 bg-dark-9/80'}">
            {selected.has(design.key) ? '✓' : ''}
          </span>
        </span>
        <span class="line-clamp-2 text-sm leading-tight font-semibold text-white">{design.name}</span>
        <span class="flex items-center justify-between gap-1 text-xs text-dark-2">
          <span>{design.shelf === null ? 'No shelf price' : `${num(design.shelf)} Buzz`}</span>
          <span class="flex gap-0.5">
            {#each design.variants as variant (variant.cosmeticId)}
              <span class="size-2 rounded-full" style:background-color={teamColor(variant.team)} title={variant.team ?? 'every team'}></span>
            {/each}
          </span>
        </span>
        <span class="text-xs text-dark-2">{typeLabel(design.type)}{design.variants.length > 1 ? ` × ${design.variants.length}` : ''}</span>
        <span class="flex flex-wrap gap-1">
          {#if where.inBox}
            <span class="rounded px-1.5 text-xs text-white" style:background-color={tier?.color ?? '#5c5f66'}>
              {tier ? `In ${tier.name || tier.key}` : 'In several tiers'}
            </span>
          {/if}
          {#if !isDefined(design)}
            <span class="rounded border border-dashed border-amber-400/60 px-1.5 text-xs text-amber-300">Needs a definition</span>
          {/if}
          {#if !ok}
            <span class="rounded border border-red-400/40 px-1.5 text-xs text-red-300">Needs event {design.event}</span>
          {/if}
        </span>
      </button>
    {/each}
  </div>
  {#if catalog.value && catalog.value.designs.length < total}
    <div class="mt-3 text-center">
      {#if filters.limit >= MAX}
        <span class="text-sm text-dark-2">Showing the first {MAX}. Narrow the search to see the rest.</span>
      {:else}
        <Button variant="outline" onclick={() => (filters = { ...filters, limit: filters.limit + CATALOG_PAGE })}>Show more</Button>
      {/if}
    </div>
  {/if}
{/if}

{#if selected.size}
  <div class="fixed inset-x-0 z-40 md:left-[var(--sidebar-width)] border-t border-blue-5 bg-dark-8/95 px-4 py-2 backdrop-blur" style:bottom="{dockHeight}px">
    <div class="mx-auto flex max-w-[1280px] flex-wrap items-center gap-2">
      <b class="text-white">{selected.size} selected</b>
      {#if pending.length}
        <form
          method="POST"
          action="?/define"
          use:enhance={defining.enhance}
          class="inline-flex items-center gap-2"
        >
          <input type="hidden" name="cosmeticIds" value={JSON.stringify(pendingCosmeticIds)} />
          <Button type="submit" size="sm" variant="outline" disabled={defining.submitting}>
            Create {pendingCosmeticIds.length} definition{pendingCosmeticIds.length === 1 ? '' : 's'}
          </Button>
        </form>
      {/if}
      <span class="text-xs text-dark-2">{inBoxCount ? 'Move to' : 'Add to'}</span>
      {#each draft.tiers as tier (tier.key)}
        <Button size="sm" variant="outline" style="border-left: 4px solid {tier.color ?? '#868e96'}" onclick={() => place(tier.key)}>
          {tier.name || tier.key}
        </Button>
      {:else}
        <span class="text-xs text-dark-2">Add a tier first (Your box tab).</span>
      {/each}
      {#if inBoxCount}
        <Button size="sm" variant="destructive" onclick={remove}>Remove from box</Button>
      {/if}
      <Button size="sm" variant="ghost" class="ml-auto" onclick={() => selected.clear()}>Clear</Button>
    </div>
    {#if defining.error}
      <ErrorAlert class="mx-auto mt-2 max-w-[1280px]" message={defining.error} />
    {/if}
  </div>
{/if}

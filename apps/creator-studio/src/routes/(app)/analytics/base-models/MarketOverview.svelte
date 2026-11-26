<script lang="ts">
  import { browser } from '$app/environment';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Skeleton } from '@civitai/ui/components/ui/skeleton/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { MarketView } from '$lib/analytics/market-overview';

  const ENDPOINT = '/analytics/base-models/market';

  let rating = $state('');
  let access = $state('');
  let type = $state('');
  let ecosystem = $state('');
  let retry = $state(0);

  const load = (query: string): Promise<MarketView> =>
    fetch(`${ENDPOINT}${query ? `?${query}` : ''}`).then((r) => {
      if (r.status === 503) throw new Error('The market overview is unavailable right now.');
      if (r.status === 404) throw new Error('The market overview is no longer available.');
      if (!r.ok) throw new Error(`Something went wrong (${r.status}).`);
      return r.json();
    });

  // Fetched once, so the ecosystem picker stays put while each filtered view loads.
  const ecosystems = browser
    ? load('').then((v) => v.ecosystems)
    : new Promise<MarketView['ecosystems']>(() => {});

  const result = $derived.by(() => {
    void retry;
    const p = new URLSearchParams();
    if (rating) p.set('rating', rating);
    if (access) p.set('access', access);
    if (type) p.set('type', type);
    if (ecosystem) p.set('ecosystem', ecosystem);
    return browser ? load(p.toString()) : new Promise<MarketView>(() => {});
  });

  const num = (n: number) => n.toLocaleString();
  const bandLabel = (min: number, max: number | null) =>
    max === null ? `${num(min)}+` : min === 0 ? `under ${num(max)}` : `${num(min)}-${num(max - 1)}`;
</script>

{#snippet tile(label: string, value: string, note?: string)}
  <div class="rounded border border-dark-4 p-3">
    <p class="text-xs text-dark-2">{label}</p>
    <p class="text-lg text-white">{value}</p>
    {#if note}<p class="text-xs text-dark-2">{note}</p>{/if}
  </div>
{/snippet}

<section class="mb-4 cs-panel p-4">
  <p class="mb-3 text-sm font-medium text-white">
    Paid models on Civitai
    <span class="text-xs text-dark-2">· a snapshot of models listed now, refreshed hourly</span>
  </p>

  <div class="mb-3 flex flex-wrap items-center gap-2">
    <ToggleGroup
      type="single"
      value={rating}
      onValueChange={(v: string) => (rating = v ?? '')}
      variant="outline"
      size="sm"
    >
      <ToggleGroupItem
        value="sfw"
        class="text-xs"
        title="Every content level the model has is PG or PG-13">SFW</ToggleGroupItem
      >
      <ToggleGroupItem
        value="nsfw"
        class="text-xs"
        title="The model has at least one R-or-above content level">NSFW</ToggleGroupItem
      >
    </ToggleGroup>
    <ToggleGroup
      type="single"
      value={access}
      onValueChange={(v: string) => (access = v ?? '')}
      variant="outline"
      size="sm"
    >
      <ToggleGroupItem value="early" class="text-xs">Early access</ToggleGroupItem>
      <ToggleGroupItem value="permanent" class="text-xs">Permanent access</ToggleGroupItem>
    </ToggleGroup>
    <ToggleGroup
      type="single"
      value={type}
      onValueChange={(v: string) => (type = v ?? '')}
      variant="outline"
      size="sm"
    >
      <ToggleGroupItem value="LORA" class="text-xs">LoRA</ToggleGroupItem>
      <ToggleGroupItem value="Checkpoint" class="text-xs">Checkpoint</ToggleGroupItem>
      <ToggleGroupItem value="Other" class="text-xs">Other types</ToggleGroupItem>
    </ToggleGroup>
    {#await ecosystems then list}
      <Select.Root
        type="single"
        value={ecosystem}
        onValueChange={(v: string) => (ecosystem = v ?? '')}
      >
        <Select.Trigger size="sm" class="w-44">
          {list.find((e) => e.key === ecosystem)?.label ?? 'All ecosystems'}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="" label="All ecosystems" />
          {#each list as eco (eco.key)}
            <Select.Item value={eco.key} label={eco.label} />
          {/each}
        </Select.Content>
      </Select.Root>
    {:catch}
      <!-- the panel below reports the failure -->
    {/await}
  </div>

  {#await result}
    <p class="mb-2 text-xs text-dark-2">Loading the paid-model market…</p>
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-hidden="true">
      {#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-16" />{/each}
    </div>
  {:then view}
    {#if view.models === 0}
      <p class="flex h-24 items-center justify-center text-sm text-dark-2">
        No buckets with 5 or more sellers match these filters.
      </p>
    {:else}
      {@const maxBand = Math.max(1, ...view.histogram.map((b) => b.versions))}
      <div class="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {@render tile('Paid models', num(view.models))}
        {@render tile('Paid versions', num(view.versions))}
        {@render tile(
          'Early access / permanent',
          `${num(view.early)} / ${num(view.permanent)}`,
          'paid versions'
        )}
      </div>

      <p class="mb-2 text-xs text-dark-2">
        Access price, in Buzz (base price; sales not applied) · paid versions
      </p>
      <ul class="space-y-1">
        {#each view.histogram as band (band.min)}
          <li class="flex items-center gap-2 text-xs">
            <span class="w-24 shrink-0 text-dark-2">{bandLabel(band.min, band.max)}</span>
            <span class="h-3 rounded bg-blue-6" style="width: {(band.versions / maxBand) * 100}%"
            ></span>
            <span class="text-dark-2">{num(band.versions)}</span>
          </li>
        {/each}
      </ul>
    {/if}

    <p class="mt-3 text-xs text-dark-2">
      Figures are of the buckets shown: a bucket with fewer than 5 sellers is hidden and counted in
      no total ({num(view.suppressed)} hidden across all of Civitai).
    </p>
  {:catch err}
    <div class="flex h-24 flex-col items-center justify-center gap-2 text-sm text-dark-2">
      {err.message}
      <Button variant="outline" size="sm" onclick={() => retry++}>Try again</Button>
    </div>
  {/await}
</section>

<script lang="ts">
  import { IconInfoCircle } from '@tabler/icons-svelte';
  import * as Empty from '@civitai/ui/components/ui/empty/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { urlWith } from '$lib/url';
  import type { stockView } from '$lib/server/knights/shop-catalog.service';
  import PlayerCard from './PlayerCard.svelte';
  import { KIND_GROUP, KIND_ORDER, cardFor, longDay, previewDays } from './shop-view';

  let {
    preview,
    today,
    url,
  }: { preview: ReturnType<typeof stockView>; today: string; url: URL } = $props();

  const isToday = $derived(preview.day === today);
  const dayItems = $derived(
    previewDays(today, preview.day).map(({ value, label }) => ({
      value,
      label,
      href: urlWith(url, { tab: 'preview', day: value === today ? null : value }),
    }))
  );
  const deals = $derived(preview.stock.filter((entry) => entry.deal));
  const sections = $derived(
    KIND_ORDER.map((kind) => ({
      kind,
      entries: preview.stock.filter((entry) => !entry.deal && entry.item.kind === kind),
    })).filter((section) => section.entries.length > 0)
  );
</script>

<div class="mb-4 flex flex-wrap items-center gap-3">
  <LinkTabs items={dayItems} active={preview.day} />
  <form method="GET" class="flex items-center gap-2">
    <input type="hidden" name="tab" value="preview" />
    <Input
      type="date"
      name="day"
      value={preview.day}
      min={today}
      class="w-40"
      aria-label="Preview another UTC day"
    />
    <Button type="submit" size="sm" variant="outline">Show</Button>
  </form>
</div>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <p class="mb-5 text-sm text-dark-2">
    The shop on <span class="text-white">{longDay(preview.day)}</span> (UTC), as players see it.
  </p>
  {#if !preview.stock.length}
    <Empty.Root class="py-10">
      <Empty.Header>
        <Empty.Title>Nothing would be on sale</Empty.Title>
        <Empty.Description>No active item can be sold on this day.</Empty.Description>
      </Empty.Header>
    </Empty.Root>
  {/if}

  {#if deals.length}
    <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-300">
      {isToday ? "Today's deals" : 'Deals that day'}
    </h3>
    <div class="mb-6 grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3">
      {#each deals as entry (entry.item.id)}
        <PlayerCard card={cardFor(entry.item, entry, entry.hidden)} variant="deal" />
      {/each}
    </div>
  {/if}

  {#each sections as section (section.kind)}
    <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-dark-2">
      {KIND_GROUP[section.kind]}
    </h3>
    <div class="mb-6 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
      {#each section.entries as entry (entry.item.id)}
        <PlayerCard card={cardFor(entry.item, entry, entry.hidden)} />
      {/each}
    </div>
  {/each}

  <div class="flex flex-col gap-1 text-xs text-dark-2">
    <p class="flex items-start gap-1.5">
      <IconInfoCircle class="mt-px size-3.5 shrink-0" />
      <span>
        Drawn from the current catalog by the same code Knights runs, so today or a later day only.
        Buzz packs show as closed to players while Knights has Buzz conversion switched off or no Buzz
        endpoint configured, which this app cannot read.
      </span>
    </p>
    {#if preview.excluded.length}
      <p class="pl-5">
        Active but never sold, because the main app sells memberships one week at a time:
        {preview.excluded.map((item) => `${item.name} (${item.days} days)`).join(', ')}.
      </p>
    {/if}
  </div>
</section>

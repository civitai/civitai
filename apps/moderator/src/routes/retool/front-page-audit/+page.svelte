<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import { cn } from '@civitai/ui/utils.js';
  import { TAG_CATEGORIES } from './moderation-tags';
  import type { ActionData, PageData } from './$types';
  import { writeEnhancer } from '$lib/form-action';
  import { dateTime, num } from '$lib/format';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { MEDIA_LABELS, ORDER_LABELS, SWEEP_LEVELS, SWEEP_MEDIA, SWEEP_ORDERS } from './sweep';
  import RatingBar from './RatingBar.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Local mirrors so changing a picker doesn't navigate twice. The effect re-syncs on back/forward,
  // where the component is not remounted.
  let level = $state(untrack(() => String(data.nsfwLevel)));
  let order = $state(untrack(() => data.order));
  let media = $state(untrack(() => data.media));
  let hours = $state(untrack(() => String(data.hours)));
  $effect(() => {
    level = String(data.nsfwLevel);
    order = data.order;
    media = data.media;
    hours = String(data.hours);
  });

  // Rated images stay on screen (removing them would renumber the grid mid-sweep) but dim, so the
  // moderator can see what they have handled in this pass. A SvelteSet so the grid re-renders on
  // mutation — a `{#key}` counter would rebuild all 200 cards on every rating.
  const handled = new SvelteSet<number>();
  // The rating the moderator just set, so the card stops showing the pre-change value without
  // refetching 200 rows.
  const newRating = new SvelteMap<number, number>();

  const onSubmit = writeEnhancer({ reload: false });

  const apply = () =>
    goto(`?level=${level}&order=${order}&media=${media}&hours=${hours}`, { keepFocus: true });

  const labelFor = (value: number) =>
    SWEEP_LEVELS.find((l) => l.value === value)?.label ?? String(value);

  // Pickers show the PENDING selection; the heading shows what is actually loaded. Labelling the
  // controls from `data` made a chosen value read as unchanged until Sweep was pressed.
  const pendingLevelLabel = $derived(labelFor(Number(level)));
  const loadedLevelLabel = $derived(labelFor(data.nsfwLevel));
</script>

<header class="page-header">
  <h1>Front Page Audit</h1>
  <p>
    Sweep newly scanned content carrying one rating and correct what is wrong. Unlike the ratings
    queue, nothing here was reported — this is the patrol.
  </p>
</header>

<section class="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <label class="flex flex-col gap-1 text-xs text-dark-2">
    Rating
    <Select.Root type="single" bind:value={level}>
      <Select.Trigger class="w-32">{pendingLevelLabel}</Select.Trigger>
      <Select.Content>
        {#each SWEEP_LEVELS as l (l.value)}
          <Select.Item value={String(l.value)}>{l.label}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </label>

  <label class="flex flex-col gap-1 text-xs text-dark-2">
    Order
    <Select.Root type="single" bind:value={order}>
      <Select.Trigger class="w-56">{ORDER_LABELS[order]}</Select.Trigger>
      <Select.Content>
        {#each SWEEP_ORDERS as o (o)}
          <Select.Item value={o}>{ORDER_LABELS[o]}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </label>

  <label class="flex flex-col gap-1 text-xs text-dark-2">
    Media
    <Select.Root type="single" bind:value={media}>
      <Select.Trigger class="w-32">{MEDIA_LABELS[media]}</Select.Trigger>
      <Select.Content>
        {#each SWEEP_MEDIA as m (m)}
          <Select.Item value={m}>{MEDIA_LABELS[m]}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </label>

  {#if order === 'newest'}
    <label class="flex flex-col gap-1 text-xs text-dark-2">
      Window (hours)
      <Select.Root type="single" bind:value={hours}>
        <Select.Trigger class="w-28">{hours}h</Select.Trigger>
        <Select.Content>
          {#each [6, 12, 24, 48, 72, 168, 720] as h (h)}
            <Select.Item value={String(h)}>{h}h</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </label>
  {/if}

  <Button onclick={apply}>Sweep</Button>
</section>

{#if form?.error}
  <div
    class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    role="alert"
  >
    {form.error}
  </div>
{/if}

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-sm font-semibold text-white">
    {num(data.items.length)} carrying {loadedLevelLabel}
  </h2>
  <p class="text-xs text-dark-2">
    {#if data.order === 'newest'}
      Scanned since {dateTime(data.since)}, oldest first — drain it and widen the window when it empties.
    {:else}
      Ranked by reactions this week. The window does not apply.
    {/if}
    {#if data.items.length >= data.limit}
      <span class="text-amber-300"> Capped at {data.limit}; narrow the window.</span>
    {/if}
  </p>
  <p class="mt-2 text-xs text-dark-2">
    The shared resume point (Retool's <code>FrontPageTimers</code>) is not ported yet, so this window is
    yours alone — two moderators sweeping the same rating will overlap. Share the URL to split a sweep.
  </p>
</section>

<ImageQueueGrid
  items={data.items}
  civitaiUrl={data.civitaiUrl}
  card={sweepCard}
  itemClass={(img) => (handled.has(img.id) ? 'opacity-40' : '')}
  empty="Nothing carrying that rating in this window — widen it, or the sweep is clean."
  endLabel={data.items.length >= data.limit ? null : 'End of sweep.'}
/>

{#snippet sweepCard(img: {
  id: number;
  nsfwLevel: number;
  aiNsfwLevel: number | null;
  needsReview: string | null;
  poi: boolean;
  createdAt: Date;
  prompt: string | null;
  moderatedTags: { id: number; name: string }[];
  isProfilePicture: boolean;
  hasConnection: boolean;
})}
  {@const rating = newRating.get(img.id) ?? img.nsfwLevel}
  <div class="flex flex-col gap-1.5 p-2 text-xs text-dark-2">
    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {#if newRating.has(img.id)}
        <Badge variant="secondary">now {getBrowsingLevelLabel(rating)}</Badge>
      {/if}
      {#if img.aiNsfwLevel != null && img.aiNsfwLevel !== rating}
        <!-- The scanner and the current rating disagree: the strongest signal that this row is why
             the sweep exists. -->
        <Badge variant="secondary">AI said {getBrowsingLevelLabel(img.aiNsfwLevel)}</Badge>
      {/if}
      {#if img.poi}<Badge variant="secondary">POI</Badge>{/if}
      {#if img.needsReview}<Badge variant="secondary">{img.needsReview}</Badge>{/if}
      <span>{dateTime(img.createdAt)}</span>
    </div>

    {#if img.moderatedTags.length}
      <!-- Voting is how a wrong moderation tag gets corrected; without the names there is nothing to
           agree or disagree with. -->
      <div class="flex flex-wrap items-center gap-1">
        {#each img.moderatedTags as tag (tag.id)}
          <span class="flex items-center gap-0.5 rounded bg-dark-7 px-1.5 py-0.5">
            <span>{tag.name}</span>
            {#if data.canAct}
              {#each [['up', '↑'], ['down', '↓']] as [direction, glyph] (direction)}
                <form method="POST" action="?/voteTag" use:enhance={onSubmit} class="inline">
                  <input type="hidden" name="imageId" value={img.id} />
                  <input type="hidden" name="tagId" value={tag.id} />
                  <input type="hidden" name="direction" value={direction} />
                  <button
                    type="submit"
                    class="px-0.5 text-dark-2 hover:text-white"
                    aria-label="{direction === 'up' ? 'Agree with' : 'Disagree with'} {tag.name}"
                  >
                    {glyph}
                  </button>
                </form>
              {/each}
            {/if}
          </span>
        {/each}
      </div>
    {/if}

    {#if data.canAct}
      <!-- Retool's TagData palette. Voting only on tags already present means a tag the auto-tagger
           MISSED can never be added, which is the case this sweep exists to catch. A tag already on
           the image is marked, so the palette doubles as "what is on this". -->
      <details class="text-xs">
        <summary class="text-dark-2 hover:text-dark-0">Add a moderation tag</summary>
        <div class="mt-1.5 space-y-1.5">
          {#each TAG_CATEGORIES as category (category.key)}
            <div class="flex flex-wrap items-center gap-1">
              <span class="w-16 shrink-0 text-dark-3">{category.label}</span>
              {#each category.tags as tag (tag.id)}
                {@const present = img.moderatedTags.some((t) => t.id === tag.id)}
                <form method="POST" action="?/voteTag" use:enhance={onSubmit} class="inline">
                  <input type="hidden" name="imageId" value={img.id} />
                  <input type="hidden" name="tagId" value={tag.id} />
                  <input type="hidden" name="direction" value={present ? 'down' : 'up'} />
                  <button
                    type="submit"
                    title="{present ? 'Remove' : 'Add'} — implies {getBrowsingLevelLabel(
                      tag.nsfwLevel
                    )}"
                    class={cn(
                      'rounded border px-1.5 py-0.5',
                      present
                        ? 'border-primary bg-primary/15 text-white'
                        : 'border-dark-4 text-dark-2 hover:bg-dark-5 hover:text-dark-0'
                    )}
                  >
                    {tag.name}
                  </button>
                </form>
              {/each}
            </div>
          {/each}
        </div>
      </details>
    {/if}

    {#if img.isProfilePicture || img.hasConnection}
      <div class="flex flex-wrap gap-1">
        {#if img.isProfilePicture}
          <span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">profile picture</span>
        {/if}
        {#if img.hasConnection}
          <span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">attached to entity</span>
        {/if}
      </div>
    {/if}

    {#if img.prompt}
      <p class="line-clamp-3 wrap-break-word" title={img.prompt}>{img.prompt}</p>
    {/if}

    {#if data.canAct}
      <RatingBar
        imageId={img.id}
        current={rating}
        {onSubmit}
        onRated={(level, ok) => {
          // Reverted on failure: an optimistic dim that never clears makes the moderator's own record
          // of "what I have handled" wrong, and the skipped card is the one that failed.
          if (!ok) {
            handled.delete(img.id);
            newRating.delete(img.id);
            return;
          }
          handled.add(img.id);
          newRating.set(img.id, level);
        }}
      />
    {/if}
  </div>
{/snippet}

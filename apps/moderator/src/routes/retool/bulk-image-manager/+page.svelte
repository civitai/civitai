<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { goto } from '$app/navigation';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import type { ActionData, PageData } from './$types';
  import { writeEnhancer } from '$lib/form-action';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { BULK_SOURCE_LABELS, BULK_SOURCES } from './sources';
  import BulkActionBar from './BulkActionBar.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Local mirrors so typing doesn't navigate, re-synced when a search lands (incl. back/forward).
  // Without the effect these hold the values from first mount and the picker lies about what is shown.
  let source = $state(untrack(() => data.source));
  let term = $state(untrack(() => data.q));
  $effect(() => {
    source = data.source;
    term = data.q;
  });

  const selected = new SvelteSet<string | number>();

  // A new batch must not carry the previous one's selection — the ids would still submit, and they
  // belong to images no longer on screen.
  $effect(() => {
    data.batch;
    selected.clear();
  });

  let submitting = $state(false);
  const onSubmit = writeEnhancer({
    reload: true,
    onSuccess: () => selected.clear(),
    busy: (value) => (submitting = value),
  });

  const search = (e: SubmitEvent) => {
    e.preventDefault();
    const value = term.trim();
    goto(value ? `?source=${source}&q=${encodeURIComponent(value)}` : `?source=${source}`, {
      keepFocus: true,
    });
  };
</script>

<header class="page-header">
  <h1>Bulk Image Manager</h1>
  <p>
    Find every image on a post, model, model version, collection or account — then remove, restore or
    notify in one action.
  </p>
</header>

<form onsubmit={search} class="mb-6 flex max-w-2xl flex-wrap gap-2">
  <Select.Root type="single" bind:value={source}>
    <Select.Trigger class="w-52">{BULK_SOURCE_LABELS[source]}</Select.Trigger>
    <Select.Content>
      {#each BULK_SOURCES as s (s)}
        <Select.Item value={s}>{BULK_SOURCE_LABELS[s]}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
  <Input bind:value={term} placeholder={BULK_SOURCE_LABELS[source]} class="min-w-48 flex-1" />
  <Button type="submit">Find images</Button>
</form>

{#if form?.error}
  <div
    class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    role="alert"
  >
    {form.error}
  </div>
{:else if form && 'warning' in form && form.warning}
  <div
    class="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-200"
    role="status"
  >
    {form.warning}
  </div>
{/if}

{#if data.notFound}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">
      No images found for <code>{data.q}</code> as a {BULK_SOURCE_LABELS[data.source].toLowerCase()}.
    </p>
  </section>
{:else if data.batch}
  {@const batch = data.batch}
  <section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-1 text-sm font-semibold text-white">
      {num(batch.items.length)} of {num(batch.total)} images
    </h2>
    <p class="mb-3 text-xs text-dark-2">
      {#if batch.truncated}
        <span class="text-amber-300">
          Capped — an action here covers only what is loaded, not all {num(batch.total)}.
        </span>
      {:else}
        The whole set.
      {/if}
      Click an image to select it once a selection has started.
    </p>

    {#if data.owners.length}
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span class="text-xs tracking-wide text-dark-2 uppercase">Owners</span>
        {#each data.owners as owner (owner.id)}
          <span class="flex items-baseline gap-1">
            <a href={userLookupUrl(owner.username ?? owner.id)} class={LINK_CLASS}>
              {owner.username ?? `#${owner.id}`}
            </a>
            {#if owner.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
          </span>
        {/each}
      </div>
    {/if}
  </section>

  {#if data.canAct}
    <BulkActionBar {selected} {onSubmit} {submitting} ownerCount={data.owners.length} />
  {/if}

  <ImageQueueGrid
    items={batch.items}
    civitaiUrl={data.civitaiUrl}
    {selected}
    card={imageCard}
    empty="No images in this batch."
  />
{/if}

{#snippet imageCard(img: {
  ingestion?: string;
  blockedFor?: string | null;
  needsReview?: string | null;
  createdAt?: Date;
})}
  <div class="flex flex-wrap items-baseline gap-x-2 p-2 text-xs text-dark-2">
    {#if img.ingestion === 'Blocked'}
      <Badge variant="destructive">blocked{img.blockedFor ? `: ${img.blockedFor}` : ''}</Badge>
    {/if}
    {#if img.needsReview}<Badge variant="secondary">{img.needsReview}</Badge>{/if}
    <span>{dateTime(img.createdAt ?? null)}</span>
  </div>
{/snippet}

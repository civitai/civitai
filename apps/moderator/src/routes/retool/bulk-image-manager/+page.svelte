<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import type { ActionData, PageData } from './$types';
  import { writeEnhancer } from '$lib/form-action';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { BULK_SOURCE_LABELS, BULK_SOURCES } from './sources';
  import ImageActionBar from '$lib/components/ImageActionBar.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Local mirrors so typing doesn't navigate. Keyed on the URL, NOT on `data`: this page's enhancer
  // reloads, so `data` is a new object after every remove/restore/flag — an effect watching it wipes a
  // half-typed id the moment the previous action's invalidation lands.
  let source = $state(untrack(() => data.source));
  let term = $state(untrack(() => data.q));
  const subject = $derived(page.url.search);
  $effect(() => {
    subject;
    untrack(() => {
      source = data.source;
      term = data.q;
    });
  });

  const selected = new SvelteSet<string | number>();

  // Same reason: a FAILED action also invalidates, and clearing on `data.batch` identity would empty
  // the selection under an error that says "narrow the selection".
  $effect(() => {
    subject;
    untrack(() => selected.clear());
  });

  // Restore is only safe on already-blocked images; the bar warns when a selection includes others.
  const blockedIds = $derived(
    new Set<string | number>(
      (data.batch?.items ?? []).filter((i) => i.ingestion === 'Blocked').map((i) => i.id)
    )
  );

  const ownerOfImage = $derived(new Map((data.batch?.items ?? []).map((i) => [i.id, i.userId])));
  const selectedOwnerCount = $derived(
    new Set([...selected].map((id) => ownerOfImage.get(Number(id))).filter((id) => id != null)).size
  );

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
  {#if source === 'imageIds'}
    <!-- A single-line input strips newlines, and Firefox CONCATENATES the pasted lines — a column of
         ids becomes one number, which either overflows int4 or lands on an unrelated image. -->
    <Textarea bind:value={term} rows={3} placeholder="One id per line, or comma-separated" class="min-w-64 flex-1" />
  {:else}
    <Input bind:value={term} placeholder={BULK_SOURCE_LABELS[source]} class="min-w-48 flex-1" />
  {/if}
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
{:else if form?.success}
  <!-- The server's count, not the submitted one: a partial removal must not read as a full one. -->
  <div
    class="mb-4 rounded-md border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200"
    role="status"
  >
    <!-- The endpoint returns the images it FOUND, not the ones it changed, so an id that was already
         blocked counts here. "Submitted" is the claim the number actually supports. -->
    {#if 'removed' in form && form.removed != null}
      Removed {num(form.removed)} images — count is images submitted, not necessarily changed.
    {:else if 'restored' in form && form.restored != null}
      Restored {num(form.restored)} images — count is images submitted, not necessarily changed.
    {:else if 'flagged' in form && form.flagged != null}
      Updated flags on {num(form.flagged)} images.
    {:else if 'notified' in form && form.notified != null}
      Notified {num(form.notified)} owners.
    {/if}
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
    <ImageActionBar
      {selected}
      selectable={batch.items.map((i) => i.id)}
      {onSubmit}
      {submitting}
      ownerCount={selectedOwnerCount}
      blockedIds={blockedIds}
    />
  {/if}

  <!-- No selection without the actions: ticking a box with no action bar leaves the moderator in a
       mode where clicking an image toggles instead of opening it, for no reason. -->
  <ImageQueueGrid
    items={batch.items}
    civitaiUrl={data.civitaiUrl}
    selected={data.canAct ? selected : undefined}
    card={imageCard}
    empty="No images in this batch."
    endLabel={batch.truncated ? null : 'End of batch.'}
  />
{/if}

{#snippet imageCard(img: {
  ingestion?: string;
  blockedFor?: string | null;
  needsReview?: string | null;
  createdAt?: Date;
  poi?: boolean;
  minor?: boolean;
  prompt?: string | null;
  isProfilePicture?: boolean;
  hasConnection?: boolean;
})}
  <div class="flex flex-col gap-1.5 p-2 text-xs text-dark-2">
    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {#if img.ingestion === 'Blocked'}
        <Badge variant="destructive">blocked{img.blockedFor ? `: ${img.blockedFor}` : ''}</Badge>
      {/if}
      {#if img.needsReview}<Badge variant="secondary">{img.needsReview}</Badge>{/if}
      {#if img.poi}<Badge variant="secondary">POI</Badge>{/if}
      {#if img.minor}<Badge variant="secondary">minor</Badge>{/if}
      <span>{dateTime(img.createdAt ?? null)}</span>
    </div>

    <!-- Removing either of these breaks something the owner did not upload: an account's avatar, or
         the image backing a bounty entry. -->
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
      <p class="line-clamp-3 wrap-break-word text-dark-2" title={img.prompt}>{img.prompt}</p>
    {/if}
  </div>
{/snippet}

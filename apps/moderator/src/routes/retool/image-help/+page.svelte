<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import type { ActionData, PageData } from './$types';
  import { FormState } from '$lib/form-state.svelte';
  import { dateTime, num } from '$lib/format';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // `needsReview` values, so these are the wire values as well as the labels.
  const HELP_TYPE_LABELS = [
    ['minor', 'Minor review'],
    ['poi', 'POI review'],
    ['reported', 'Reported images'],
  ] as const;
  const onSubmit = new FormState({ onSuccess: null, reload: true });
</script>

<header class="page-header">
  <h1>Image Help Requests</h1>
  <p>Second opinions other moderators have asked for. Oldest first — clear them as you answer.</p>
</header>

{#if form?.error}
  <div
    class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    role="alert"
  >
    {form.error}
  </div>
{:else}
  <!-- Both, not either/or: a capped batch sets `filed` AND `warning`, and testing the warning first
       hid the fact that a request was created at all. -->
  {#if form && 'filed' in form && form.filed != null}
    <div
      class="mb-4 rounded-md border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200"
      role="status"
    >
      Filed a request covering {num(form.filed)} images.
    </div>
  {/if}
  {#if form && 'warning' in form && form.warning}
    <div
      class="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-200"
      role="status"
    >
      {form.warning}
    </div>
  {/if}
{/if}

<!-- Retool's three "file the current backlog" buttons. Without them this page only drains requests
     Retool made, so it empties for good once Retool is switched off. -->
{#if data.canAct}
  <section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-1 text-sm font-semibold text-white">Ask for help</h2>
    <p class="mb-3 text-xs text-dark-2">
      Files everything currently waiting for review as one request for the team to work through.
    </p>
    <div class="flex flex-wrap gap-2">
      {#each HELP_TYPE_LABELS as [type, label] (type)}
        <form method="POST" action="?/file" use:enhance={onSubmit.enhance}>
          <input type="hidden" name="type" value={type} />
          <Button type="submit" variant="outline" size="sm" disabled={onSubmit.submitting}>{label}</Button>
        </form>
      {/each}
    </div>
  </section>
{/if}

{#if !data.requests.length}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">Nothing open. Every help request has been handled.</p>
  </section>
{:else}
  <div class="flex flex-col gap-4 lg:flex-row">
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-5 lg:w-80 lg:shrink-0">
      <h2 class="mb-3 text-sm font-semibold text-white">
        {num(data.requests.length)} open
      </h2>
      <ul class="flex flex-col gap-1">
        {#each data.requests as req (req.id)}
          <li>
            <a
              href="?request={req.id}"
              class="flex flex-col gap-0.5 rounded-md border p-2 text-xs {req.id === data.selected?.id
                ? 'border-blue-500/40 bg-blue-500/5'
                : 'border-dark-4 hover:bg-dark-7'}"
            >
              <span class="flex items-baseline justify-between gap-2">
                <span class="font-semibold text-white">{req.createdBy ?? 'unknown'}</span>
                <span class="text-dark-2">{num(req.imageIds.length)} image(s)</span>
              </span>
              <span class="text-dark-2">
                {#if req.type}<Badge variant="secondary">{req.type}</Badge>{/if}
                {dateTime(req.createdAt)}
              </span>
            </a>
          </li>
        {/each}
      </ul>
    </section>

    <section class="min-w-0 flex-1">
      {#if data.selected}
        {@const selected = data.selected}
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dark-4 bg-dark-6 p-5">
          <div class="text-sm text-dark-2">
            <span class="font-semibold text-white">{selected.createdBy ?? 'unknown'}</span>
            asked {dateTime(selected.createdAt)}
            {#if selected.type}· <Badge variant="secondary">{selected.type}</Badge>{/if}
            {#if selected.imageIds.length !== data.images.length}
              <span class="text-amber-300">
                · {num(selected.imageIds.length - data.images.length)} of the requested images no longer
                exist
              </span>
            {/if}
          </div>

          {#if data.canAct}
            <div class="flex flex-wrap gap-2">
              {#if data.images.length}
                <!-- Acting on the batch reuses Bulk Image Manager's reviewed destructive path rather
                     than growing a second one here. Retool had no action on this queue at all. -->
                <Button
                  href="/retool/bulk-image-manager?source=imageIds&q={data.images
                    .map((i) => i.id)
                    .join(',')}"
                  variant="outline"
                  size="sm"
                >
                  Act on these {data.images.length} in Bulk Image Manager
                </Button>
              {/if}
              <form method="POST" action="?/resolve" use:enhance={onSubmit.enhance}>
                <input type="hidden" name="requestId" value={selected.id} />
                <Button type="submit" size="sm" disabled={onSubmit.submitting}>
                  {onSubmit.submitting ? 'Marking…' : 'Mark handled'}
                </Button>
              </form>
            </div>
          {/if}
        </div>

        <ImageQueueGrid
          items={data.images}
          civitaiUrl={data.civitaiUrl}
          card={helpCard}
          empty="None of the images in this request still exist."
          endLabel={null}
        />
      {:else}
        <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
          <p class="text-sm text-dark-2">Pick a request on the left.</p>
        </div>
      {/if}
    </section>
  </div>
{/if}

{#snippet helpCard(img: {
  ingestion?: string;
  blockedFor?: string | null;
  needsReview?: string | null;
})}
  <div class="flex flex-wrap items-baseline gap-x-2 p-2 text-xs text-dark-2">
    {#if img.ingestion === 'Blocked'}
      <Badge variant="destructive">blocked{img.blockedFor ? `: ${img.blockedFor}` : ''}</Badge>
    {/if}
    {#if img.needsReview}<Badge variant="secondary">{img.needsReview}</Badge>{/if}
    {#if !img.needsReview && img.ingestion !== 'Blocked'}<span>no flags</span>{/if}
  </div>
{/snippet}

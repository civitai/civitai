<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import { LINK_CLASS, num, shortAge } from '$lib/format';
  import { clearPaging } from '$lib/paging';
  import { SelectionSet } from '@civitai/ui/hooks/selection-set.svelte.js';
  import IngestionHealthPanel from './IngestionHealthPanel.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  type Item = PageData['images'][number];

  const selected = new SelectionSet<string | number>();
  $effect(() => {
    data.images;
    selected.clear();
  });
  const selectedIds = $derived([...selected].join(','));
  const stuckView = $derived(data.view === 'stuck');

  let submitting = $state(false);
  const submitRescan: SubmitFunction = () => {
    submitting = true;
    return async ({ update }) => {
      await update();
      submitting = false;
    };
  };

  // Links rather than `Tabs`, as on users/newest: a tab control cannot be middle-clicked.
  const viewHref = (view: PageData['view']) => {
    const url = new URL(page.url);
    clearPaging(url.searchParams);
    if (view === 'recent') url.searchParams.delete('view');
    else url.searchParams.set('view', view);
    return url.pathname + url.search;
  };
  const viewClass = (active: boolean) => (active ? 'text-white underline' : LINK_CLASS);
</script>

<header class="page-header">
  <h1>Images to Ingest</h1>
  {#if stuckView}
    <p>
      {data.health ? `${num(data.health.stuck)} scans` : 'Scans'} with no verdict after
      {data.stuckMinutes} minutes, no age limit
    </p>
  {:else}
    <p>{num(data.total ?? 0)} images pending ingestion in the last {data.recentDays} days</p>
  {/if}

  <nav class="mt-3 flex gap-3 text-sm">
    <a
      href={viewHref('recent')}
      aria-current={data.view === 'recent' ? 'page' : undefined}
      class={viewClass(data.view === 'recent')}>Last {data.recentDays} days</a
    >
    <a
      href={viewHref('stuck')}
      aria-current={stuckView ? 'page' : undefined}
      class={viewClass(stuckView)}>Stuck past {data.stuckMinutes} min</a
    >
  </nav>
</header>

<IngestionHealthPanel health={data.health} stuckMinutes={data.stuckMinutes} />

{#if form?.error}
  <ErrorAlert class="mb-4" message={form.error} />
{:else if form?.success}
  <p class="mb-4 text-sm text-teal-400">
    Queued {num(form.count)} images for rescan. The ingest job sends them within a few minutes.
  </p>
{/if}

{#if stuckView && data.images.length > 0}
  <form method="POST" action="?/rescan" use:enhance={submitRescan} class="mb-4">
    <input type="hidden" name="all" value="true" />
    <Button type="submit" size="sm" variant="outline" disabled={submitting}>
      Rescan all stuck (oldest {num(data.maxRescan)})
    </Button>
  </form>
{/if}

{#snippet card(image: Item)}
  <div class="flex items-center justify-between text-xs text-muted-foreground">
    <span class="tabular-nums">#{image.id}</span>
    <Badge variant="secondary">{shortAge(image.createdAt)}</Badge>
  </div>
{/snippet}

<ImageQueueGrid
  items={data.images}
  civitaiUrl={data.civitaiUrl}
  nextCursor={data.nextCursor}
  {card}
  selected={stuckView ? selected : undefined}
  empty={stuckView
    ? `Nothing stuck. Every pending scan is under ${data.stuckMinutes} minutes old.`
    : 'No images pending ingestion.'}
/>

{#if stuckView && selected.size > 0}
  <!-- spacer so the fixed bar can't cover the last row / Next button -->
  <div class="h-20"></div>
  <div
    class="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 px-4 py-3 backdrop-blur"
  >
    <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
      <span class="text-sm font-semibold">{selected.size} selected</span>
      <button
        onclick={() => selected.clear()}
        class="text-xs text-muted-foreground hover:text-foreground">Clear</button
      >
      <form method="POST" action="?/rescan" use:enhance={submitRescan} class="ml-auto">
        <input type="hidden" name="imageIds" value={selectedIds} />
        <Button type="submit" size="sm" disabled={submitting}>Rescan selected</Button>
      </form>
    </div>
  </div>
{/if}

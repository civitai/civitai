<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { PageData } from './$types';
  import ActivityPanel from './ActivityPanel.svelte';
  import ImageDetailPanel from './ImageDetailPanel.svelte';
  import ImageSignalsPanel from './ImageSignalsPanel.svelte';
  import TagsPanel from './TagsPanel.svelte';

  let { data }: { data: PageData } = $props();

  // Local copy so typing doesn't navigate; re-synced whenever a search lands (incl. back/forward).
  let term = $state(untrack(() => data.q));
  $effect(() => {
    term = data.q;
  });

  const search = (e: SubmitEvent) => {
    e.preventDefault();
    const value = term.trim();
    goto(value ? `?q=${encodeURIComponent(value)}` : '?', { keepFocus: true });
  };
</script>

<header class="page-header">
  <h1>Image Lookup</h1>
  <p>Find an image by ID or URL — what it is, how it was tagged, and who reacted to it.</p>
</header>

<form onsubmit={search} class="mb-6 flex max-w-xl gap-2">
  <Input bind:value={term} placeholder="138967815, or a full image URL" class="flex-1" />
  <Button type="submit">Search</Button>
</form>

{#if data.notFound}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">No image matches <code>{data.q}</code>.</p>
  </section>
{:else if data.deletedImageId}
  <section class="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-5">
    <h2 class="text-lg font-semibold text-white">Image #{data.deletedImageId} no longer exists</h2>
    <p class="mt-1 text-sm text-amber-200">
      The row is gone from the database, which is what a ToS removal does. Its lifecycle log survives and
      is below — that is where the removal reason lives.
    </p>
  </section>
  {#key data.deletedImageId}
    <ImageSignalsPanel imageId={data.deletedImageId} deleted />
  {/key}
{:else if data.result}
  {@const result = data.result}
  <!-- One key over every panel: a `?q=` navigation does not remount, so an expanded reaction list or
       event log would otherwise carry across to the next image. -->
  {#key result.image.id}
    <ImageDetailPanel image={result.image} civitaiUrl={data.civitaiUrl} />
    <TagsPanel tags={result.tags} shadowTags={result.shadowTags} />
    <ActivityPanel
      reports={result.reports}
      modActivity={result.modActivity}
      reactions={result.reactions}
    />
    <ImageSignalsPanel imageId={result.image.id} />
  {/key}
{/if}

<script lang="ts">
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import EdgeImage from '$lib/components/EdgeImage.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { optimisticEnhancer } from '$lib/form-action';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { imageLookupUrl, modelVersionUrl, userLookupUrl } from '$lib/entity-url';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // PG and PG-13; anything above is blurred until opened in the image lookup.
  const SAFE_LEVELS = 1 | 2;

  type Row = PageData['items'][number];
  const keyOf = (row: Row) => `${row.modelVersionId}:${row.imageId}`;

  const removing = new SvelteSet<string>();
  // A row stays marked until the list stops showing it: a lagging read can still return it.
  $effect(() => {
    const shown = new Set(data.items.map(keyOf));
    untrack(() => {
      for (const key of removing) if (!shown.has(key)) removing.delete(key);
    });
  });

  const refusal = $derived(
    form && 'error' in form && form.error
      ? 'imageId' in form && form.imageId
        ? `Image #${form.imageId}: ${form.error}`
        : form.error
      : null
  );

  const submit = (key: string) =>
    optimisticEnhancer(
      () => {
        removing.add(key);
        return () => removing.delete(key);
      },
      { reload: true }
    );
</script>

<header class="page-header">
  <h1>Featured Community Images</h1>
</header>

<p class="mb-4 text-sm text-dark-2">
  Images by other people that creators featured in their model showcases. Removing one takes it out
  of that version's showcase on both sites, and the creator can't feature it again.
</p>

<form method="GET" class="mb-4 flex flex-wrap items-end gap-2">
  <label class="text-sm">
    <span class="mb-1 block text-dark-2">Image id</span>
    <Input name="image" inputmode="numeric" value={data.filters.image ?? ''} class="w-36" />
  </label>
  <label class="text-sm">
    <span class="mb-1 block text-dark-2">Model id</span>
    <Input name="model" inputmode="numeric" value={data.filters.model ?? ''} class="w-36" />
  </label>
  <label class="text-sm">
    <span class="mb-1 block text-dark-2">Image author</span>
    <Input name="author" value={data.filters.author} class="w-48" />
  </label>
  <label class="flex items-center gap-2 pb-2 text-sm">
    <Checkbox name="removed" value="1" checked={data.filters.removed} />
    Include removed
  </label>
  <Button type="submit" variant="secondary">Filter</Button>
</form>

{#if refusal}
  <ErrorAlert class="mb-4" message={refusal} />
{/if}

{#if data.hasMore}
  <p class="mb-2 text-xs text-dark-2">Showing the latest {data.limit}.</p>
{/if}

{#if data.items.length === 0}
  <p class="text-sm text-dark-2">No featured images match.</p>
{:else}
  <ul class="space-y-2">
    {#each data.items as row (keyOf(row))}
      {@const key = keyOf(row)}
      <li
        class={cn(
          'flex gap-4 rounded-lg border border-dark-4 bg-dark-6 p-3 transition-opacity',
          removing.has(key) && 'opacity-50'
        )}
      >
        <a href={imageLookupUrl(row.imageId)} class="shrink-0">
          <EdgeImage
            src={row.imageUrl}
            type={row.imageType === 'video' ? 'video' : 'image'}
            width={96}
            blur={(row.nsfwLevel & ~SAFE_LEVELS) !== 0 ? 250 : undefined}
            class="h-24 w-24 rounded object-cover"
            alt="Featured image {row.imageId}"
          />
        </a>
        <div class="min-w-0 flex-1 text-sm">
          <div class="flex flex-wrap items-baseline gap-x-2">
            <a
              href={modelVersionUrl(data.civitaiUrl, row.modelId, row.modelVersionId)}
              target="_blank"
              rel="noreferrer"
              class="font-medium {LINK_CLASS}"
            >
              {row.modelName} · {row.versionName}
            </a>
            {#each row.sites as site (site)}
              <Badge variant="secondary">civitai.{site}</Badge>
            {/each}
            {#if row.removed}
              <Badge variant="outline">removed</Badge>
            {/if}
          </div>
          <p class="mt-1 text-dark-2">
            Image <a href={imageLookupUrl(row.imageId)} class={LINK_CLASS}>#{row.imageId}</a>
            by
            {#if row.author}
              <a href={userLookupUrl(row.author)} class={LINK_CLASS}>{row.author}</a>
            {:else}
              a deleted account
            {/if}
            · featured by {row.featuredBy ?? 'a deleted account'} on {dateTime(row.featuredAt)}
          </p>
        </div>
        {#if !row.removed}
          <form
            method="POST"
            action="?/remove"
            use:enhance={submit(key)}
            class="shrink-0 self-center"
          >
            <input type="hidden" name="modelVersionId" value={row.modelVersionId} />
            <input type="hidden" name="imageId" value={row.imageId} />
            <Button type="submit" variant="destructive" size="sm" disabled={removing.has(key)}>
              Remove
            </Button>
          </form>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

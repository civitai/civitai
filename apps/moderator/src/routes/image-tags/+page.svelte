<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { SvelteMap } from 'svelte/reactivity';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Card, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // `${imageId}:${tagId}` → the mod's decision (optimistic; dims the chip / card).
  const resolved = new SvelteMap<string, 'removed' | 'kept'>();
  $effect(() => {
    data.items;
    resolved.clear();
  });

  const key = (imageId: number, tagId: number) => `${imageId}:${tagId}`;

  const submit: SubmitFunction = ({ formData }) => {
    const imageId = Number(formData.get('imageId'));
    const outcome = formData.get('disable') === 'true' ? 'removed' : 'kept';
    const rawTagId = formData.get('tagId');
    if (rawTagId) {
      resolved.set(key(imageId, Number(rawTagId)), outcome);
    } else {
      const img = data.items.find((i) => i.id === imageId);
      img?.tags
        .filter((t) => t.needsReview)
        .forEach((t) => resolved.set(key(imageId, t.tagId), outcome));
    }
    return async ({ update }) => update({ invalidateAll: false });
  };

  function navigate(params: Record<string, string | number | null>) {
    const url = new URL(page.url);
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === '') url.searchParams.delete(k);
      else url.searchParams.set(k, String(v));
    }
    goto(url.pathname + url.search);
  }
</script>

<header class="page-header">
  <h1>Tags Needing Review</h1>
  <p class="text-sm text-muted-foreground">
    Images with a moderation tag the community voted to remove. Approve the removal or keep the tag.
  </p>
</header>

<div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
  <span class="inline-flex items-center gap-1.5">
    <span class="inline-block h-3 w-5 rounded ring-2 ring-inset ring-violet-400"></span> flagged for review
  </span>
  <span class="text-muted-foreground/70">· Remove = approve removal · Keep = decline · one click commits</span>
</div>

{#if data.items.length === 0}
  <div class="placeholder">No tags to review.</div>
{:else}
  <div class="grid gap-5" style="grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))">
    {#each data.items as item (item.id)}
      {@const flagged = item.tags.filter((t) => t.needsReview)}
      {@const pending = flagged.filter((t) => !resolved.has(key(item.id, t.tagId)))}
      {@const done = flagged.length > 0 && pending.length === 0}
      <Card class="gap-0 overflow-hidden p-0 transition-opacity {done ? 'opacity-60' : ''}">
        <div class="flex aspect-[4/5] items-center justify-center overflow-hidden bg-muted">
          <a
            href={`${data.civitaiUrl}/images/${item.id}`}
            target="_blank"
            rel="noreferrer"
            class="flex h-full w-full items-center justify-center"
          >
            <EdgeMedia src={item.url} type={item.type} width={450} class="max-h-full max-w-full object-contain" />
          </a>
        </div>
        <CardContent class="flex flex-col gap-2 p-2.5">
          {#each item.tags as tag (tag.tagId)}
            {@const outcome = resolved.get(key(item.id, tag.tagId))}
            <div
              class="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm {tag.needsReview
                ? 'ring-2 ring-inset ring-violet-400'
                : 'border-border opacity-60'} {outcome ? 'opacity-50' : ''}"
            >
              <span class="flex-1 font-medium">{tag.name}</span>
              <span class="text-xs tabular-nums text-muted-foreground">↑{tag.upVotes} ↓{tag.downVotes}</span>
              {#if tag.needsReview}
                {#if outcome}
                  <span
                    class="text-xs font-semibold {outcome === 'removed'
                      ? 'text-rose-500'
                      : 'text-teal-500'}"
                  >
                    {outcome === 'removed' ? '✓ Removed' : '✓ Kept'}
                  </span>
                {:else}
                  <form method="POST" action="?/moderate" use:enhance={submit} class="flex gap-1">
                    <input type="hidden" name="imageId" value={item.id} />
                    <input type="hidden" name="tagId" value={tag.tagId} />
                    <button
                      type="submit"
                      name="disable"
                      value="true"
                      class="rounded border border-rose-500/40 px-2 py-0.5 text-xs font-semibold text-rose-400 transition hover:bg-rose-500/10"
                    >
                      Remove
                    </button>
                    <button
                      type="submit"
                      name="disable"
                      value="false"
                      class="rounded border border-teal-600/40 px-2 py-0.5 text-xs font-semibold text-teal-400 transition hover:bg-teal-500/10"
                    >
                      Keep
                    </button>
                  </form>
                {/if}
              {/if}
            </div>
          {/each}

          {#if pending.length > 1}
            <form method="POST" action="?/moderate" use:enhance={submit} class="mt-1 flex gap-2">
              <input type="hidden" name="imageId" value={item.id} />
              <button
                type="submit"
                name="disable"
                value="true"
                class="flex-1 rounded-md border border-rose-500/40 py-1 text-xs font-semibold text-rose-400 transition hover:bg-rose-500/10"
              >
                Remove all ({pending.length})
              </button>
              <button
                type="submit"
                name="disable"
                value="false"
                class="flex-1 rounded-md border border-teal-600/40 py-1 text-xs font-semibold text-teal-400 transition hover:bg-teal-500/10"
              >
                Keep all
              </button>
            </form>
          {/if}
        </CardContent>
      </Card>
    {/each}
  </div>

  <div class="mt-6 flex justify-center">
    {#if data.nextCursor}
      <Button size="lg" onclick={() => navigate({ cursor: data.nextCursor ?? null })}>Next</Button>
    {:else}
      <span class="text-sm text-muted-foreground">End of queue.</span>
    {/if}
  </div>
{/if}

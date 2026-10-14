<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { getEdgeUrl } from '$lib/media/edge-url';
  import { shouldBlurThumbnail } from '$lib/minor-flags/appeal-row';
  import type { AppealCoverImage } from '$lib/server/minor-hash.service';

  let { images }: { images: AppealCoverImage[] } = $props();

  const revealed = new SvelteSet<number>();
  const toggle = (id: number) => (revealed.has(id) ? revealed.delete(id) : revealed.add(id));
</script>

{#if images.length}
  <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
    {#each images as image, i (image.id)}
      {@const hidden = shouldBlurThumbnail(image.nsfwLevel) && !revealed.has(image.id)}
      <div class="relative h-60 overflow-hidden rounded-lg border border-dark-4 bg-dark-7">
        {#if hidden}
          <button
            type="button"
            onclick={() => toggle(image.id)}
            aria-label="Reveal image {i + 1} of {images.length}"
            class="size-full"
          >
            <EdgeMedia
              src={image.url}
              type="image"
              width={450}
              blur={40}
              class="size-full object-cover"
            />
            <span
              class="absolute inset-0 grid place-items-center bg-black/30 text-sm font-medium text-white"
            >
              Click to reveal
            </span>
          </button>
        {:else}
          <a
            href={getEdgeUrl(image.url, { type: 'image', original: true })}
            target="_blank"
            rel="noreferrer"
            aria-label="Open image {i + 1} of {images.length} full size"
            class="block size-full"
          >
            <EdgeMedia src={image.url} type="image" width={450} class="size-full object-cover" />
          </a>
          {#if shouldBlurThumbnail(image.nsfwLevel)}
            <Button
              size="sm"
              variant="secondary"
              aria-label="Blur image {i + 1}"
              class="absolute bottom-2 left-2"
              onclick={() => toggle(image.id)}
            >
              Blur
            </Button>
          {/if}
        {/if}
      </div>
    {/each}
  </div>
{:else}
  <p class="m-0 rounded-lg border border-dashed border-dark-4 p-6 text-center text-sm text-dark-0">
    No published images on this model's posts.
  </p>
{/if}

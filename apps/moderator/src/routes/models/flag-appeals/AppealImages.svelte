<script lang="ts">
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { getEdgeUrl } from '$lib/media/edge-url';
  import type { AppealCoverImage } from '$lib/server/minor-hash.service';

  let { images }: { images: AppealCoverImage[] } = $props();
</script>

{#if images.length}
  <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
    {#each images as image, i (image.id)}
      <a
        href={getEdgeUrl(image.url, { type: 'image', original: true })}
        target="_blank"
        rel="noreferrer"
        aria-label="Open image {i + 1} of {images.length} full size"
        class="block h-60 overflow-hidden rounded-lg border border-dark-4 bg-dark-7"
      >
        <EdgeMedia src={image.url} type="image" width={450} class="size-full object-cover" />
      </a>
    {/each}
  </div>
{:else}
  <p class="m-0 rounded-lg border border-dashed border-dark-4 p-6 text-center text-sm text-dark-0">
    No images on this model's posts.
  </p>
{/if}

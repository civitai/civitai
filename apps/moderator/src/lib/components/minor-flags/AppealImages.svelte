<script lang="ts">
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { getEdgeUrl } from '$lib/media/edge-url';
  import type { AppealCoverImage } from '$lib/server/minor-hash.service';

  let {
    images,
    blurred = false,
  }: {
    images: AppealCoverImage[];
    /** Hides the pictures behind a blur; the rating label stays readable. */
    blurred?: boolean;
  } = $props();
</script>

{#if images.length}
  <!-- As many columns as tiles (up to four), so two or three previews fill the row. -->
  <div
    class="grid grid-cols-2 gap-2.5 md:grid-cols-[repeat(var(--tiles),minmax(0,1fr))]"
    style:--tiles={Math.min(images.length, 4)}
  >
    {#each images as image, i (image.id)}
      <a
        href={getEdgeUrl(image.url, { type: 'image', original: true })}
        target="_blank"
        rel="noreferrer"
        aria-label="Open image {i + 1} of {images.length} full size"
        class="relative block h-[180px] overflow-hidden rounded-lg border border-dark-4 bg-dark-6"
      >
        <EdgeMedia src={image.url} type="image" width={450} class={blurred ? 'size-full scale-110 object-cover blur-xl' : 'size-full object-cover'} />
        <span
          class="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-px text-[10px] font-semibold text-white"
        >
          {getBrowsingLevelLabel(image.nsfwLevel)}
        </span>
      </a>
    {/each}
  </div>
{:else}
  <p class="m-0 rounded-lg border border-dashed border-dark-4 p-6 text-center text-sm text-dark-0">
    No images on this model's posts.
  </p>
{/if}

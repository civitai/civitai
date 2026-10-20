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
  <!-- Four columns whatever the count, so every model's tiles are the same size to compare. -->
  <div class="grid grid-cols-2 gap-2.5 md:grid-cols-4">
    {#each images as image, i (image.id)}
      <svelte:element
        this={blurred ? 'div' : 'a'}
        href={blurred ? undefined : getEdgeUrl(image.url, { type: 'image', original: true })}
        target={blurred ? undefined : '_blank'}
        rel={blurred ? undefined : 'noreferrer'}
        aria-label={blurred
          ? `Image ${i + 1} of ${images.length}, hidden`
          : `Open image ${i + 1} of ${images.length} full size`}
        role={blurred ? 'img' : undefined}
        class="relative block aspect-[4/5] overflow-hidden rounded-lg border border-dark-4 bg-dark-6"
      >
        <EdgeMedia
          src={image.url}
          type="image"
          width={450}
          class={blurred
            ? 'size-full scale-110 object-cover object-top blur-xl'
            : 'size-full object-cover object-top'}
        />
        <span
          class="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-px text-[10px] font-semibold text-white"
        >
          {getBrowsingLevelLabel(image.nsfwLevel)}
        </span>
      </svelte:element>
    {/each}
  </div>
{:else}
  <p class="m-0 rounded-lg border border-dashed border-dark-4 p-6 text-center text-sm text-dark-0">
    No images on this model's posts.
  </p>
{/if}

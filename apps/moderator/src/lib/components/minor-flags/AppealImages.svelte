<script lang="ts">
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { getEdgeUrl } from '$lib/media/edge-url';
  import type { AppealCoverImage } from '$lib/server/minor-hash.service';

  let {
    images,
    blurred = false,
    emptyText = "No images on this model's posts.",
  }: {
    images: AppealCoverImage[];
    blurred?: boolean;
    emptyText?: string;
  } = $props();

  const mediaType = (image: AppealCoverImage) => (image.type === 'video' ? 'video' : 'image');
</script>

{#if images.length}
  <div class="grid grid-cols-2 gap-2.5 md:grid-cols-4">
    {#each images as image, i (image.id)}
      <svelte:element
        this={blurred ? 'div' : 'a'}
        href={blurred ? undefined : getEdgeUrl(image.url, { type: mediaType(image), original: true })}
        target={blurred ? undefined : '_blank'}
        rel={blurred ? undefined : 'noreferrer'}
        aria-label={blurred
          ? `${mediaType(image) === 'video' ? 'Video' : 'Image'} ${i + 1} of ${images.length}, hidden`
          : `Open ${mediaType(image)} ${i + 1} of ${images.length} full size`}
        role={blurred ? 'img' : undefined}
        class="relative block aspect-[4/5] overflow-hidden rounded-lg border border-dark-4 bg-dark-6"
      >
        <EdgeMedia
          src={image.url}
          type={mediaType(image)}
          width={450}
          anim={false}
          hoverPlay={!blurred}
          class={blurred
            ? 'size-full scale-110 object-cover object-top blur-xl'
            : 'size-full object-cover object-top'}
        />
        {#if image.caption}
          <span
            class="absolute top-2 left-2 rounded bg-black/60 px-1.5 py-px text-[10px] font-semibold text-white"
          >
            {image.caption}
          </span>
        {/if}
        <span class="absolute bottom-2 left-2 flex flex-wrap gap-1 text-[10px] font-semibold text-white">
          <span class="rounded bg-black/60 px-1.5 py-px">
            {getBrowsingLevelLabel(image.nsfwLevel)}
          </span>
          {#if image.minor}
            <span class="rounded bg-destructive px-1.5 py-px">minor</span>
          {:else if image.acceptableMinor}
            <span class="rounded bg-secondary px-1.5 py-px text-secondary-foreground">
              acceptable minor
            </span>
          {/if}
        </span>
      </svelte:element>
    {/each}
  </div>
{:else}
  <p class="m-0 rounded-lg border border-dashed border-dark-4 p-6 text-center text-sm text-dark-0">
    {emptyText}
  </p>
{/if}

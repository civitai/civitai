<script lang="ts">
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { RETRACTED_REFUSED } from '$lib/held-media';

  let {
    item,
    width,
    alt,
    class: className,
  }: {
    item: { imageKey: string; imageName?: string | null; restricted: boolean };
    width: number;
    alt: string;
    class?: string;
  } = $props();
</script>

{#if item.restricted}
  <div
    class="grid aspect-[3/4] place-items-center rounded-md bg-dark-5 p-4 text-center text-xs text-dark-2"
    style="width: {width}px"
    data-testid="trial-media-withheld"
  >
    {RETRACTED_REFUSED}
  </div>
{:else}
  <EdgeMedia src={item.imageKey} name={item.imageName} {width} {alt} class={className} />
{/if}

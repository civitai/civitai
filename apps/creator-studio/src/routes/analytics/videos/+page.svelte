<script lang="ts">
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { formatRange } from '$lib/date-range';
  import AnalyticsHeader from '$lib/components/AnalyticsHeader.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);
  let showAll = $state(false);
  const shown = $derived(data.videos ? (showAll ? data.videos : data.videos.slice(0, 15)) : []);
</script>

<AnalyticsHeader range={data.range} compare={data.compare} showCompare={false} />

{#if data.videos === null}
  <div class="placeholder">Videos are temporarily unavailable — please try again shortly.</div>
{:else if data.videos.length === 0}
  <div class="placeholder">No video reactions {periodLabel} yet.</div>
{:else}
  <p class="mb-3 text-sm font-medium text-white">
    Top videos by reactions <span class="text-xs text-dark-3">{periodLabel}</span>
  </p>
  <div class="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5">
    {#each shown as vid, i (vid.imageId)}
      <!-- mature (nsfwLevel > 3) links to civitai.red -->
      <a
        href="https://civitai.{vid.nsfwLevel > 3 ? 'red' : 'com'}/images/{vid.imageId}"
        target="_blank"
        rel="noreferrer"
        class="group relative block aspect-square overflow-hidden rounded-lg border border-dark-4 bg-dark-7"
      >
        <EdgeMedia
          src={vid.url}
          type={vid.type}
          width={450}
          alt="Top video #{vid.imageId}"
          class="h-full w-full object-cover transition-transform group-hover:scale-105"
        />
        <div class="absolute inset-x-0 top-0 flex justify-start bg-linear-to-b from-black/60 to-transparent px-2 py-1">
          <span class="text-xs font-semibold text-white">#{i + 1}</span>
        </div>
        <div class="absolute inset-x-0 bottom-0 flex justify-end bg-linear-to-t from-black/70 to-transparent px-2 py-1.5">
          <span class="text-xs font-semibold text-white">♥ {num(vid.reactions)}</span>
        </div>
      </a>
    {/each}
  </div>
  {#if data.videos.length > 15}
    <button
      type="button"
      onclick={() => (showAll = !showAll)}
      class="mt-3 cursor-pointer text-xs text-dark-2 hover:text-white"
    >
      {showAll ? 'Show less' : `Show all ${data.videos.length}`}
    </button>
  {/if}
{/if}

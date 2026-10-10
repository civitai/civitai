<script lang="ts">
  import type { TrainingAsset } from '$lib/training-media';

  let {
    assets,
    columns = 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
    preload = 'metadata',
  }: {
    assets: TrainingAsset[];
    columns?: string;
    /** `none` where each media request costs a server round trip and is logged as a view. */
    preload?: 'metadata' | 'none';
  } = $props();
</script>

{#if assets.length === 0}
  <p class="py-8 text-center text-sm text-dark-2">No media found in the training data.</p>
{:else}
  <div class="grid gap-3 {columns}">
    {#each assets as asset (asset.name)}
      <figure class="overflow-hidden rounded-lg border border-dark-4 bg-dark-7">
        {#if asset.kind === 'image'}
          <img
            src={asset.url}
            alt={asset.name}
            title={asset.name}
            loading="lazy"
            class="max-h-64 w-full object-contain"
          />
        {:else if asset.kind === 'video'}
          <video controls muted loop playsinline {preload} class="max-h-64 w-full">
            <source src={asset.url} type={asset.mimeType} />
          </video>
        {:else}
          <audio controls {preload} src={asset.url} class="w-full p-2"></audio>
        {/if}
        <figcaption class="px-2 py-1 text-xs text-dark-2">
          <span class="block truncate" title={asset.name}>{asset.name}</span>
          {#if asset.caption !== undefined}
            <span class="mt-1 block break-words whitespace-pre-wrap text-dark-0">
              {asset.caption ?? '(no caption)'}
            </span>
          {/if}
        </figcaption>
      </figure>
    {/each}
  </div>
{/if}

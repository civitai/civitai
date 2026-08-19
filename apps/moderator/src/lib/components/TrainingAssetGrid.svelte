<script lang="ts">
  import type { TrainingAsset } from '$lib/training-zip';

  let { assets, columns = 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4' }: {
    assets: TrainingAsset[];
    columns?: string;
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
          <video controls muted loop playsinline preload="metadata" class="max-h-64 w-full">
            <source src={asset.url} type={asset.mimeType} />
          </video>
        {:else}
          <audio controls src={asset.url} class="w-full p-2"></audio>
        {/if}
        <figcaption class="truncate px-2 py-1 text-xs text-dark-2" title={asset.name}>
          {asset.name}
        </figcaption>
      </figure>
    {/each}
  </div>
{/if}

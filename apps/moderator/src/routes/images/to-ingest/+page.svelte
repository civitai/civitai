<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const daysAgo = (d: Date) => {
    const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
    return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
  };
  const aspect = (m: unknown) => {
    const meta = (m ?? {}) as { width?: number; height?: number };
    return (meta.width ?? 1) / (meta.height ?? 1);
  };
</script>

<header class="page-header">
  <h1>Images to Ingest</h1>
  <p>{data.images.length} images pending ingestion</p>
</header>

{#if data.images.length === 0}
  <div class="placeholder">No images pending ingestion.</div>
{:else}
  <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
    {#each data.images as image (image.id)}
      <a
        href={`${data.civitaiUrl}/images/${image.id}`}
        target="_blank"
        rel="noreferrer"
        class="relative block overflow-hidden rounded-lg border bg-muted"
      >
        <div style={`aspect-ratio: ${aspect(image.metadata)}`}>
          <EdgeMedia
            src={image.url}
            type={image.type}
            name={image.name}
            width={400}
            alt={image.name ?? `Image ${image.id}`}
            class="size-full object-cover"
          />
        </div>
        <Badge class="absolute left-2 top-2">{daysAgo(image.createdAt)}</Badge>
      </a>
    {/each}
  </div>
{/if}

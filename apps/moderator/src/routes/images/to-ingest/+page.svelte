<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  type Item = PageData['images'][number];

  const daysAgo = (d: Date) => {
    const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
    return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
  };
</script>

<header class="page-header">
  <h1>Images to Ingest</h1>
  <p>{data.total} images pending ingestion</p>
</header>

{#snippet card(image: Item)}
  <div class="flex items-center justify-between text-xs text-muted-foreground">
    <span class="tabular-nums">#{image.id}</span>
    <Badge variant="secondary">{daysAgo(image.createdAt)}</Badge>
  </div>
{/snippet}

<ImageQueueGrid
  items={data.images}
  civitaiUrl={data.civitaiUrl}
  nextCursor={data.nextCursor}
  {card}
  empty="No images pending ingestion."
/>

<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import ImageReviewGrid from '$lib/components/ImageReviewGrid.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<ImageReviewGrid
  title={data.title}
  items={data.items}
  level={data.level}
  civitaiUrl={data.civitaiUrl}
  nextCursor={data.nextCursor}
>
  {#snippet detail()}
    <Badge class="w-fit bg-rose-600/20 font-semibold text-rose-500">CSAM — flagged for review</Badge>
  {/snippet}
</ImageReviewGrid>

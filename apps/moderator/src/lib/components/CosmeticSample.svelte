<script lang="ts">
  import EdgeImage from './EdgeImage.svelte';
  import type { CosmeticData } from '$lib/cosmetics';

  // v1 sample: url-based cosmetics (Badge / ProfileDecoration / ProfileBackground) render their image;
  // nameplates + content-decoration frames are identified by the name + type badge in the row.
  let { type, name, data }: { type: string; name: string; data: unknown } = $props();

  const url = $derived((data as CosmeticData)?.url ?? null);
  const showsImage = $derived(
    type === 'Badge' || type === 'ProfileDecoration' || type === 'ProfileBackground'
  );
</script>

{#if showsImage && url}
  <EdgeImage src={url} width={64} alt={name} class="max-h-16 w-auto rounded" />
{:else}
  <span class="text-xs text-muted-foreground">—</span>
{/if}

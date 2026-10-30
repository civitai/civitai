<script lang="ts">
  import EdgeMedia from './EdgeMedia.svelte';
  import type { CosmeticData } from '$lib/cosmetics';

  // v1 sample: url-based cosmetics (Badge / ProfileDecoration / ProfileBackground) render their media;
  // nameplates + content-decoration frames are identified by the name + type badge in the row. `type`
  // here is the CosmeticType; the media type (backgrounds can be video) is on the cosmetic's data.
  let { type, name, data }: { type: string; name: string; data: unknown } = $props();

  const parsed = $derived((data as CosmeticData) ?? null);
  const url = $derived(parsed?.url ?? null);
  const mediaType = $derived(parsed?.type ?? undefined);
  const showsMedia = $derived(
    type === 'Badge' || type === 'ProfileDecoration' || type === 'ProfileBackground'
  );
</script>

{#if showsMedia && url}
  <EdgeMedia src={url} type={mediaType ?? undefined} {name} width={64} alt={name} class="max-h-16 w-auto rounded" />
{:else}
  <span class="text-xs text-muted-foreground">—</span>
{/if}

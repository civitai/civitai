<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import DetectionKindBadge from '$lib/components/minor-flags/DetectionKindBadge.svelte';
  import { detectionKind } from '$lib/minor-flags/text-scan-verdicts';
  import type { FlaggedRow } from '$lib/server/minor-hash.service';

  let {
    row,
    size = 'sm',
  }: { row: Pick<FlaggedRow, 'source' | 'redetected'>; size?: 'sm' | 'md' } = $props();
</script>

{#if row.source === 'redetected' && row.redetected}
  <DetectionKindBadge kind={detectionKind(row.redetected)} {size} />
{:else}
  <Badge
    variant="outline"
    class={cn(
      size === 'md' ? 'h-6 px-2.5 text-sm' : 'h-5 px-2 text-xs',
      'border-amber-500/40 bg-amber-500/15 text-amber-300'
    )}
  >
    Hash match
  </Badge>
{/if}

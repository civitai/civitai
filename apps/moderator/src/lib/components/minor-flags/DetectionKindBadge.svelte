<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { detectionCopy, type DetectionKind } from '$lib/minor-flags/text-scan-verdicts';

  let { kind, size = 'sm' }: { kind: DetectionKind; size?: 'sm' | 'md' } = $props();

  const TONE = {
    first: 'border-blue-500/40 bg-blue-500/15 text-blue-300',
    redetected: 'border-dark-3 bg-dark-5 text-dark-0',
  } as const;
</script>

<Badge
  variant="outline"
  class={cn(size === 'md' ? 'h-6 px-2.5 text-sm' : 'h-5 px-2 text-xs', TONE[kind])}
>
  {detectionCopy(kind).badge}
</Badge>

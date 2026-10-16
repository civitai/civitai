<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { cn } from '@civitai/ui/utils.js';

  let {
    label,
    size = 'sm',
  }: { label: 'minor' | 'poi'; size?: 'sm' | 'md' } = $props();

  const TONE = {
    minor: 'border-red-500/40 bg-red-500/15 text-red-300',
    poi: 'border-orange-500/40 bg-orange-500/15 text-orange-300',
  } as const;
  const NAME = { minor: 'Minor', poi: 'Real person' } as const;
</script>

<Badge
  variant="outline"
  class={cn(size === 'md' ? 'h-6 px-2.5 text-sm' : 'h-5 px-2 text-xs', TONE[label])}
>
  {NAME[label]}
</Badge>

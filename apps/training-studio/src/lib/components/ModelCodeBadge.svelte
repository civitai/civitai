<script module lang="ts">
  export type BadgeSize = 'xs' | 'sm' | 'md' | 'lg';
  const SIZES: Record<BadgeSize, string> = {
    xs: 'h-6 w-6 text-[9px]',
    sm: 'h-7 w-7 text-[9px]',
    md: 'h-8 w-8 text-[10px]',
    lg: 'h-9 w-9 text-[10px]',
  };
</script>

<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';

  let {
    code,
    size = 'md',
    class: className = '',
  }: { code: string; size?: BadgeSize; class?: string } = $props();
</script>

<span
  class={cn(
    'grid shrink-0 place-items-center rounded bg-primary/10 font-mono font-extrabold text-primary',
    SIZES[size],
    className,
  )}
>
  {code}
</span>

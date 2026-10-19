<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { cn } from '@civitai/ui/utils.js';

  let {
    tone = 'neutral',
    children,
  }: {
    tone?: 'neutral' | 'blue' | 'violet' | 'amber' | 'green' | 'red';
    children: Snippet;
  } = $props();

  // Solid chip, coloured outline and text: the tone reads without tinting the fill.
  const TONE = {
    neutral: 'border-dark-1 text-dark-1',
    blue: 'border-blue-400 text-blue-400',
    violet: 'border-violet-400 text-violet-400',
    amber: 'border-amber-400 text-amber-400',
    green: 'border-emerald-400 text-emerald-400',
    red: 'border-red-400 text-red-400',
  } as const;
</script>

<Badge
  variant="outline"
  class={cn('h-auto rounded bg-dark-6 px-[7px] py-0.5 text-[11px] leading-[13px] font-medium', TONE[tone])}
>
  {@render children()}
</Badge>

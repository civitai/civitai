<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { cn } from '@civitai/ui/utils.js';

  let {
    tone = 'neutral',
    size = 'sm',
    children,
  }: {
    tone?: 'neutral' | 'blue' | 'violet' | 'amber' | 'green' | 'red';
    size?: 'sm' | 'md';
    children: Snippet;
  } = $props();

  const TONE = {
    neutral: 'border-dark-3 bg-transparent text-dark-1',
    blue: 'border-blue-500/50 bg-blue-500/10 text-blue-300',
    violet: 'border-violet-500/50 bg-violet-500/10 text-violet-300',
    amber: 'border-amber-500/50 bg-amber-500/10 text-amber-300',
    green: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300',
    red: 'border-red-500/50 bg-red-500/10 text-red-300',
  } as const;
</script>

<Badge
  variant="outline"
  class={cn(size === 'md' ? 'h-6 px-2.5 text-sm' : 'h-5 px-2 text-xs', 'font-normal', TONE[tone])}
>
  {@render children()}
</Badge>

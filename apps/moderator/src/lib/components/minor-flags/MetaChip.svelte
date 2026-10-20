<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { cn } from '@civitai/ui/utils.js';

  let {
    tone = 'neutral',
    solid = false,
    truncate = false,
    children,
  }: {
    tone?: 'neutral' | 'blue' | 'violet' | 'amber' | 'green' | 'red';
    /** Filled with the tone, white text: the one chip that names what the item is (an appeal). */
    solid?: boolean;
    /** Clip a long label with an ellipsis inside the row instead of overflowing it. */
    truncate?: boolean;
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
  const SOLID = {
    neutral: 'border-dark-1 bg-dark-1',
    blue: 'border-blue-400 bg-blue-400',
    violet: 'border-violet-400 bg-violet-400',
    amber: 'border-amber-400 bg-amber-400',
    green: 'border-emerald-400 bg-emerald-400',
    red: 'border-red-400 bg-red-400',
  } as const;
</script>

<Badge
  variant="outline"
  class={cn(
    'h-auto rounded px-[7px] py-0.5 text-[11px] leading-[13px] font-medium',
    solid ? ['text-white', SOLID[tone]] : ['bg-dark-6', TONE[tone]],
    truncate && 'min-w-0 max-w-full'
  )}
>
  {#if truncate}<span class="truncate">{@render children()}</span>{:else}{@render children()}{/if}
</Badge>

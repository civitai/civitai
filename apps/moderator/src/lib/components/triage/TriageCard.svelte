<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '@civitai/ui/utils.js';

  let {
    title,
    dense = false,
    accent,
    children,
  }: {
    title: string;
    /** The compact card of a flush triage page: small muted title, 13px body, tighter padding. */
    dense?: boolean;
    accent?: 'red' | 'neutral' | 'blue' | 'amber';
    children: Snippet;
  } = $props();
</script>

<section
  class={cn(
    'border border-dark-4 bg-dark-7',
    accent && 'border-l-[3px]',
    accent === 'red' && 'border-l-red-500',
    accent === 'neutral' && 'border-l-dark-1',
    accent === 'blue' && 'border-l-blue-500',
    accent === 'amber' && 'border-l-amber-500',
    dense ? 'rounded-lg p-3.5 text-[13px]' : 'rounded-xl p-5'
  )}
>
  <h3
    class={cn(
      'm-0 uppercase',
      dense
        ? 'mb-2 text-[11px] font-semibold tracking-[0.5px] text-dark-2'
        : 'mb-3 text-sm font-semibold tracking-wide text-white'
    )}
  >
    {title}
  </h3>
  {@render children()}
</section>

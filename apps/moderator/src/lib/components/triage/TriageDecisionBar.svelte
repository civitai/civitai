<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '@civitai/ui/utils.js';

  /** The action area of a detail pane: the decision buttons, then the reason line, then a hint. */
  let {
    buttons,
    fields,
    picker,
    problem,
    hint,
    compact = false,
  }: {
    buttons: Snippet;
    /** The second line: the reason and note a decision button submits with. */
    fields?: Snippet;
    /** The numbered reason list a decision key opens, above the reason line. */
    picker?: Snippet;
    /** Why the last decision was not submitted, e.g. no reason picked. */
    problem?: string | null;
    hint?: string;
    /** For a sidebar: the buttons two to a row, wrapping their labels, and the hint held to two lines.
     *  Pair with `InlineReasonFields`' `compact`. */
    compact?: boolean;
  } = $props();
</script>

<!-- Container query, not viewport: the same bar sits in a wide pane (CSAM, ratings) or a narrow
     sidebar (Model Flags). -->
<div class={cn('@container flex w-full flex-col', compact ? 'gap-2' : 'gap-2.5')}>
  <div
    class={compact
      ? 'grid grid-cols-2 gap-1.5 [&>button]:h-auto [&>button]:min-h-8 [&>button]:w-full [&>button]:justify-start [&>button]:py-1.5 [&>button]:text-left [&>button]:leading-tight [&>button]:whitespace-normal'
      : 'flex flex-wrap items-center gap-2'}
  >
    {@render buttons()}
  </div>
  {#if picker}{@render picker()}{/if}
  {#if fields}
    <div class={cn('flex items-center', compact ? 'flex-nowrap gap-1.5' : 'flex-wrap gap-2 @lg:flex-nowrap')}>
      {@render fields()}
    </div>
  {/if}
  {#if problem}<p role="alert" class="m-0 text-xs text-red-300">{problem}</p>{/if}
  {#if hint}
    <p class={cn('m-0 text-[11px] text-dark-2', compact && 'line-clamp-2')} title={compact ? hint : undefined}>
      {hint}
    </p>
  {/if}
</div>

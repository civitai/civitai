<script lang="ts">
  import type { Snippet } from 'svelte';

  /** The action area of a detail pane: the decision buttons, then the reason line, then a hint. */
  let {
    buttons,
    fields,
    problem,
    hint,
  }: {
    buttons: Snippet;
    /** The second line: the reason and note a decision button submits with. */
    fields?: Snippet;
    /** Why the last decision was not submitted, e.g. no reason picked. */
    problem?: string | null;
    hint?: string;
  } = $props();
</script>

<div class="flex w-full flex-col gap-2.5">
  <div class="flex flex-wrap items-center gap-2">{@render buttons()}</div>
  {#if fields}
    <div class="flex flex-wrap items-center gap-2 sm:flex-nowrap">{@render fields()}</div>
  {/if}
  {#if problem}<p role="alert" class="m-0 text-xs text-red-300">{problem}</p>{/if}
  {#if hint}<p class="m-0 text-[11px] text-dark-2">{hint}</p>{/if}
</div>

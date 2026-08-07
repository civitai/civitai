<script lang="ts">
  import type { Snippet } from 'svelte';
  import { LINK_CLASS } from '$lib/format';

  let {
    title,
    total,
    hint,
    empty = 'None.',
    shown = 5,
    children,
  }: {
    title: string;
    total: number;
    hint?: string;
    empty?: string;
    shown?: number;
    /** Receives how many rows to render — the card owns the expand toggle. */
    children: Snippet<[number]>;
  } = $props();

  let expanded = $state(false);
  const limit = $derived(expanded ? total : shown);
</script>

<div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="text-sm font-semibold text-white" class:mb-1={hint} class:mb-3={!hint}>
    {title} ({total})
  </h3>
  {#if hint}
    <p class="mb-3 text-xs text-dark-2">{hint}</p>
  {/if}

  {#if total === 0}
    <p class="text-sm text-dark-2">{empty}</p>
  {:else}
    {@render children(limit)}
    {#if total > shown}
      <button type="button" class="mt-3 text-sm {LINK_CLASS}" onclick={() => (expanded = !expanded)}>
        {expanded ? 'Show less' : `Show all ${total}`}
      </button>
    {/if}
  {/if}
</div>

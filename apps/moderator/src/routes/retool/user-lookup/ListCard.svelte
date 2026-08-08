<script lang="ts">
  import type { Snippet } from 'svelte';
  import ShowMoreButton from '$lib/components/ShowMoreButton.svelte';

  // `capped` says the SERVER truncated the list, so `total` is what was loaded rather than what
  // exists. Without it the heading and the toggle both report a limit as a total — "Model comments
  // (25) … Show all 25" on an account with 4,000, while Content Overview shows the real count from an
  // uncapped query.
  let {
    title,
    total,
    hint,
    empty = 'None.',
    shown = 5,
    capped = false,
    children,
  }: {
    title: string;
    total: number;
    hint?: string;
    empty?: string;
    shown?: number;
    capped?: boolean;
    /** Receives how many rows to render — the card owns the expand toggle. */
    children: Snippet<[number]>;
  } = $props();

  let expanded = $state(false);
  const limit = $derived(expanded ? total : shown);
</script>

<div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="text-sm font-semibold text-white" class:mb-1={hint} class:mb-3={!hint}>
    {title} ({total}{capped ? '+' : ''})
  </h3>
  {#if hint}
    <p class="mb-3 text-xs text-dark-2">{hint}</p>
  {/if}

  {#if total === 0}
    <p class="text-sm text-dark-2">{empty}</p>
  {:else}
    {@render children(limit)}
    <ShowMoreButton {total} {shown} {expanded} {capped} onToggle={() => (expanded = !expanded)} />
  {/if}
</div>

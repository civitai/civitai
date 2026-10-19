<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    reference,
    chips,
    links,
  }: {
    title: string;
    /** The muted id after the title. */
    reference: string;
    /** Status chips under the title. */
    chips: Snippet;
    /** Small outline buttons on the right; where the item lives is one of them. */
    links?: Snippet;
  } = $props();
</script>

<header class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
  <div class="min-w-0 space-y-1.5">
    <div class="flex flex-wrap items-baseline gap-x-2">
      <h2 class="m-0 text-lg font-semibold break-words text-white">{title}</h2>
      <span class="text-[13px] text-dark-2 tabular-nums">{reference}</span>
    </div>
    <div class="flex flex-wrap items-center gap-1">{@render chips()}</div>
  </div>
  {#if links}
    <div class="flex flex-wrap items-center gap-2">{@render links()}</div>
  {/if}
</header>

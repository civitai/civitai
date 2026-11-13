<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    reference,
    chips,
    links,
    linksBeside = false,
  }: {
    title: string;
    /** The muted id after the title. */
    reference: string;
    /** Status chips under the title. */
    chips: Snippet;
    /** Small outline buttons on the right; where the item lives is one of them. */
    links?: Snippet;
    /** Keep the links on the title row whatever the title's length: the title truncates instead, its
     *  reference staying beside it. A pane too narrow for the reference and the links still wraps them
     *  below, as the reference cannot shrink. */
    linksBeside?: boolean;
  } = $props();
</script>

<header class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
  <div class="space-y-1.5 {linksBeside ? 'min-w-48 flex-1' : 'min-w-0'}">
    {#if linksBeside}
      <div class="flex min-w-0 items-baseline gap-x-2">
        <h2 class="m-0 min-w-0 truncate text-lg font-semibold text-white" {title}>{title}</h2>
        <span class="shrink-0 text-[13px] whitespace-nowrap text-dark-2 tabular-nums">{reference}</span>
      </div>
    {:else}
      <div class="flex flex-wrap items-baseline gap-x-2">
        <h2 class="m-0 text-lg font-semibold break-words text-white">{title}</h2>
        <span class="text-[13px] text-dark-2 tabular-nums">{reference}</span>
      </div>
    {/if}
    <div class="flex flex-wrap items-center gap-1">{@render chips()}</div>
  </div>
  {#if links}
    <div class="flex items-center gap-2 {linksBeside ? 'shrink-0' : 'flex-wrap'}">
      {@render links()}
    </div>
  {/if}
</header>

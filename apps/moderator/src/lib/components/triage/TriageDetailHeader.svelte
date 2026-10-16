<script lang="ts">
  import type { Snippet } from 'svelte';
  import { LINK_CLASS } from '$lib/format';

  let {
    title,
    titleHref,
    reference,
    chips,
    links,
  }: {
    title: string;
    /** Opens the item where it lives; the title is the link. */
    titleHref: string;
    /** The muted id after the title. */
    reference: string;
    /** Status chips under the title. */
    chips: Snippet;
    /** Outline buttons on the right. */
    links?: Snippet;
  } = $props();
</script>

<header class="space-y-2">
  <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
    <div class="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
      <a
        href={titleHref}
        target="_blank"
        rel="noreferrer"
        class="text-xl font-semibold break-words {LINK_CLASS}"
      >
        {title}
      </a>
      <span class="text-sm text-dark-2 tabular-nums">{reference}</span>
    </div>
    {#if links}
      <div class="flex flex-wrap gap-2">{@render links()}</div>
    {/if}
  </div>
  <div class="flex flex-wrap items-center gap-1.5">{@render chips()}</div>
</header>

<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import { LINK_CLASS } from '$lib/format';
  import type { CardSection } from '$lib/server/tickets/section';

  let {
    title,
    section,
    empty,
    row,
    rowKey,
    href,
    linkLabel = 'User Lookup',
    truncatedLabel,
    listClass = 'gap-1',
    itemClass = 'min-w-0 break-words',
  }: {
    title: string;
    section: CardSection<T>;
    /** Shown when the section is ok and has no rows. */
    empty: string;
    row: Snippet<[T]>;
    /** A stable id per row; rows are keyed by position without one. */
    rowKey?: (row: T) => string | number;
    /** Where the source of the section lives; the header is the title alone without one. */
    href?: string;
    linkLabel?: string;
    /** The link label once the list is cut; "All in <linkLabel>" by default. */
    truncatedLabel?: string;
    listClass?: string;
    itemClass?: string;
  } = $props();

  const cutLabel = $derived(truncatedLabel ?? `All in ${linkLabel}`);
</script>

<div class="flex flex-col gap-1">
  {#if href}
    <div class="flex items-baseline justify-between gap-2">
      <span class="font-medium text-white">{title}</span>
      <a class={LINK_CLASS} {href}>{section.status === 'ok' && section.truncated ? cutLabel : linkLabel}</a>
    </div>
  {:else}
    <span class="font-medium text-white">{title}</span>
  {/if}
  {#if section.status === 'unavailable'}
    <p class="m-0 text-amber-300">Unavailable.</p>
  {:else if section.rows.length === 0}
    <p class="m-0 text-dark-2">{empty}</p>
  {:else}
    <ul class="m-0 flex list-none flex-col p-0 {listClass}">
      {#each section.rows as r, i (rowKey ? rowKey(r) : i)}
        <li class={itemClass}>{@render row(r)}</li>
      {/each}
    </ul>
    {#if section.truncated}<p class="m-0 text-dark-2">Showing the newest {section.rows.length}.</p>{/if}
  {/if}
</div>

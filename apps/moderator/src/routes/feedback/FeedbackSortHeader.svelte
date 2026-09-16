<script lang="ts">
  import { page } from '$app/state';
  import { TableHead } from '@civitai/ui/components/ui/table/index.js';
  import {
    feedbackSortAria,
    feedbackSortHref,
    feedbackSortMarker,
    type FeedbackSort,
    type FeedbackSortColumn,
  } from '$lib/feedback-sort';

  /** `sortable: null` is a header that does not sort — see `FEEDBACK_SORT_COLUMNS` for which do. */
  export type FeedbackColumn = {
    id: string;
    label: string;
    sortable: FeedbackSortColumn | null;
    class?: string;
  };

  let { column, sort }: { column: FeedbackColumn; sort: FeedbackSort | null } = $props();
</script>

<!--
  🔴 A LINK, AND THE ORDERING IS THE SERVER'S — never a `.sort()` over the loaded page and never a
  `<button>`. `$lib/feedback-sort.ts` carries both arguments; the short version is that the queue is
  keyset-paged, so sorting the loaded rows orders one page and presents it as the whole queue.

  The three `data-sveltekit-*` attributes are the set the tab strip carries, for the same reasons
  (`FeedbackTabs.svelte`): without `noscroll` a sort click throws the operator back to the top of the
  queue, away from the row they have open; without `keepfocus` a keyboard operator is dropped to the
  top of the document, so cycling asc→desc→none means re-tabbing to the header three times; without
  `replacestate` the three clicks it takes to get back to unsorted leave three history entries and
  Back stops leaving the page.
-->
<TableHead
  class={column.class}
  aria-sort={column.sortable ? feedbackSortAria(sort, column.sortable) : undefined}
>
  {#if column.sortable}
    <!--
      ⚠️ `flex w-full` MAKES THE WHOLE CELL THE HIT TARGET, AND IT OVERRIDES THE CELL'S ALIGNMENT.
      A flex container lays its children out by `justify-content`, not by the `text-align` it
      inherits from the `<th>` — so a sortable column that ever carries `text-right` through
      `column.class` would render left-aligned while every other cell in that column stayed right.
      No such column exists (the only right-aligned one is 📎, which is deliberately not sortable),
      so this is a note for whoever adds the first: it needs `justify-end` HERE, not just the cell
      class. The anchor was `inline-flex` before it moved out of `+page.svelte`, which respected the
      cell but gave a hit target only as wide as the label.
    -->
    <a
      href={feedbackSortHref(page.url, column.sortable)}
      data-sveltekit-noscroll
      data-sveltekit-replacestate
      data-sveltekit-keepfocus
      class="flex w-full items-center gap-1 hover:text-white"
    >
      <!-- `aria-hidden`: `aria-sort` on the cell already announces the direction, and without this
           the active header reads as "Age up arrow, link" on top of it. -->
      {column.label}<span class="text-xs tabular-nums" aria-hidden="true"
        >{feedbackSortMarker(sort, column.sortable)}</span
      >
    </a>
  {:else}
    {column.label}
  {/if}
</TableHead>

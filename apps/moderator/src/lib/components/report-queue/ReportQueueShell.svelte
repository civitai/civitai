<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * The page shape every non-table report queue shares: the queue on the left, the open item across the
   * rest. Mods work one report at a time, so the item gets the room — a table across most of the width
   * left the details squeezed into a column taller than the screen.
   *
   * The page owns its height (the layout's load returns `fullBleed`) so each column scrolls on its own
   * and nothing is ever below the fold. Used by the queue's `+layout.svelte`, with the open item's page
   * as `detail`.
   */
  let {
    queue,
    detail,
    detailLabel,
  }: {
    /** The queue column — `ReportQueueColumn`. */
    queue: Snippet;
    /** The open item — the child page, usually laid out with `ReportDetailColumns`. */
    detail: Snippet;
    detailLabel: string;
  } = $props();
</script>

<div class="flex flex-col gap-4 px-6 pb-6 xl:h-[calc(100svh-3rem)] xl:flex-row xl:items-stretch">
  <section
    aria-label="Report queue"
    class="flex min-h-0 min-w-0 flex-col gap-3 xl:h-full xl:w-96 xl:shrink-0"
  >
    {@render queue()}
  </section>

  <section aria-label={detailLabel} class="flex min-w-0 flex-1 flex-col gap-3 xl:h-full xl:min-h-0">
    {@render detail()}
  </section>
</div>

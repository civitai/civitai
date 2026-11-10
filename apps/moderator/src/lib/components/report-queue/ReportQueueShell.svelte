<script lang="ts">
  import type { Snippet } from 'svelte';
  import TriagePageHeader from '$lib/components/triage/TriagePageHeader.svelte';
  import type { ReportEntity } from '$lib/reports';
  import LastWorked from './LastWorked.svelte';

  /**
   * The page shape every non-table report queue shares: the queue on the left, the open item across the
   * rest. Mods work one report at a time, so the item gets the room — a table across most of the width
   * left the details squeezed into a column taller than the screen.
   *
   * Laid out as the triage pages are (`TriageShell`'s `flush`): a page header, then a fixed-width queue
   * flush against the item, edge to edge. The page owns its height (the layout's load returns
   * `fullBleed` and `headerInline`) so each column scrolls on its own and nothing is ever below the
   * fold. Used by the queue's `+layout.svelte`, with the open item's page as `detail`.
   */
  let {
    title,
    entity,
    queue,
    detail,
    detailLabel,
  }: {
    title: string;
    entity: ReportEntity;
    /** The queue column — `ReportQueueColumn`. */
    queue: Snippet;
    /** The open item — the child page, laid out with `ReportDetailColumns`. */
    detail: Snippet;
    detailLabel: string;
  } = $props();
</script>

<div class="flex flex-col xl:h-svh">
  <TriagePageHeader {title}>
    {#snippet meta()}<LastWorked {entity} />{/snippet}
  </TriagePageHeader>

  <div class="flex min-h-0 flex-1 flex-col border-t border-dark-4 xl:flex-row">
    <aside
      aria-label="Report queue"
      class="flex min-h-0 flex-col border-b border-dark-4 bg-dark-7 xl:w-[400px] xl:shrink-0 xl:border-r xl:border-b-0"
    >
      {@render queue()}
    </aside>

    <!-- `relative` bounds a `SelectionBar` in the detail to this pane, off the queue column. -->
    <section
      aria-label={detailLabel}
      class="relative flex min-w-0 flex-1 flex-col bg-dark-8 xl:min-h-0"
    >
      {@render detail()}
    </section>
  </div>
</div>

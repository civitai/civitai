<script lang="ts">
  import type { Snippet } from 'svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import ReportDetailColumns from '$lib/components/report-queue/ReportDetailColumns.svelte';

  /**
   * A triage queue's open item on the report queues' columns (`ReportDetailColumns`): the item's
   * header over what is being judged, the page's own cards in the sidebar, and the decision pinned
   * under them. The column counterpart of `TriageDetailFrame`, for a detail inside `TriageShell`.
   *
   * Pair the decision with `TriageDecisionBar`'s `compact`: in a sidebar's width the full bar stacks
   * into a block that hides the sidebar on a 1080p screen.
   */
  let {
    verdict,
    error,
    header,
    evidence,
    info,
    decision,
  }: {
    /** The outcome already chosen for this item, shown in place of the decision. */
    verdict: string | undefined;
    error: string | undefined;
    header: Snippet;
    /** What is being judged, in the middle column. */
    evidence: Snippet;
    /** The sidebar's cards. */
    info: Snippet;
    /** Omitted when the item takes no decision here (a resolved one): no bar at all. */
    decision?: Snippet;
  } = $props();
</script>

<!-- Below `xl` the columns stack and the pane scrolls as one. -->
<div class="flex min-h-0 flex-1 flex-col overflow-y-auto xl:overflow-hidden">
  <ReportDetailColumns {header} {evidence} actions={info} footer={decision ? footer : undefined} />
</div>

<!-- `data-triage-actions` is where `TriageShell` puts focus after a refusal. -->
{#snippet footer()}
  {#if error}<ErrorAlert class="mb-3" message={error} />{/if}
  <div data-triage-actions class="flex flex-col gap-2">
    <!-- No whitespace inside: `empty:` must match while there is no verdict. -->
    <div role="status" class="text-base font-medium text-white empty:sr-only">{#if verdict}{verdict}{/if}</div>
    {#if !verdict}{@render decision?.()}{/if}
  </div>
{/snippet}

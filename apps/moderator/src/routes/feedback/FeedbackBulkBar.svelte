<script lang="ts">
  import { enhance } from '$app/forms';
  import TipButton from '$lib/components/TipButton.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import SelectionBar from '$lib/components/SelectionBar.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import {
    FEEDBACK_BULK_ACTIONS,
    encodeFeedbackBulkRows,
    type FeedbackBulkRow,
  } from '$lib/feedback-bulk';

  let {
    rows,
    onclear,
  }: {
    /**
     * The selected rows AS THE QUEUE CURRENTLY SHOWS THEM — id plus the status on screen.
     *
     * 🔴 THE STATUS HALF IS THE CONCURRENCY GUARD AND IT MUST COME FROM `data`, never from anything
     * this component remembers. It is the value the operator was looking at when they decided, which
     * is exactly what the server compares against before writing.
     */
    rows: FeedbackBulkRow[];
    onclear: () => void;
  } = $props();

  const payload = $derived(encodeFeedbackBulkRows(rows));

  /**
   * 🔴 `reload: true` IS THE LOAD-BEARING OPTION, AND ITS ABSENCE IS SILENT. Without it this bar
   * reports "Updated 10 reports" over a table still showing every one of them at its old status —
   * the default view filters on `status=new`, so rows that should have left the queue stay in it.
   * The operator's next click then posts the STALE expectation and is refused over their own write.
   * `applyAction` alone does NOT invalidate — only `update()` does — so a hand-rolled callback that
   * calls just `applyAction` carries exactly this defect.
   *
   * 🔴 `reset: false`: `update()` calls `HTMLFormElement.reset()`, which restores each field's
   * `defaultValue`, and Svelte writes `element.value` and never `defaultValue`. The hidden `rows`
   * input is Svelte-written, so a reset would leave this form posting an EMPTY selection.
   *
   * The selection is cleared on success only: after a refusal the operator still has it, so a retry
   * is not fifty checkboxes again.
   */
  const bulkForm = new FormState({
    // 🔴 A CLOSURE, NOT `onSuccess: onclear`. `FormState` is constructed once, so passing the prop
    // directly captures the value it had at construction — `state_referenced_locally`, which
    // `svelte-check` reports as a WARNING and which nothing else in the toolchain sees.
    onSuccess: () => onclear(),
    reload: true,
    reset: false,
  });
</script>

<!-- `clearDisabled`: this component's FormState holds the refusal. +page.svelte has a fallback for
     the same hazard reached by unticking rows. -->
<SelectionBar count={rows.length} {onclear} clearDisabled={bulkForm.submitting}>
  {#snippet actions()}
    <form
      method="POST"
      action="?/bulkTriage"
      use:enhance={bulkForm.enhance}
      class="ml-auto flex flex-wrap items-center gap-2"
    >
      <!-- 🔴 One hidden input carrying id AND expected status per row. A bare id list would post
           past the per-row concurrency guard the single-row action enforces. -->
      <input type="hidden" name="rows" value={payload} />
      <!-- 🔴 NO TEXT FIELD IN THIS FORM, AND THAT IS LOAD-BEARING RATHER THAN INCIDENTAL. A bulk
           action has no default verdict, but HTML implicit submission picks one anyway — the
           FIRST submit button, which is `FEEDBACK_STATUSES[0]` = Reopen. A text input here would
           make Enter reopen the whole selection. Adding one means guarding it. -->
      {#each FEEDBACK_BULK_ACTIONS as action (action.status)}
        <TipButton
          tip={action.tip}
          type="submit"
          name="status"
          value={action.status}
          size="sm"
          variant="outline"
          disabled={bulkForm.submitting || rows.length === 0}
        >
          {action.label}
        </TipButton>
      {/each}
    </form>
  {/snippet}
  {#if bulkForm.error}
    <ErrorAlert message={bulkForm.error} />
  {/if}
  <p class="text-xs text-dark-2">
    Reports already at the status you pick are skipped, and any a colleague has triaged since this
    page loaded are refused and reported back. Notes stay per report — use a report's own panel.
  </p>
</SelectionBar>

<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import {
    FEEDBACK_BULK_ACTIONS,
    blockImplicitBulkSubmit,
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

  let note = $state('');

  /**
   * 🔴 `reload: true` IS THE LOAD-BEARING OPTION, AND ITS ABSENCE IS SILENT. Without it this bar
   * reports "Updated 10 reports" over a table still showing every one of them at its old status —
   * the default view filters on `status=new`, so rows that should have left the queue stay in it.
   * The operator's next click then posts the STALE expectation and is refused with "someone else
   * already triaged this" over their own write. A hand-rolled callback calling only `applyAction`
   * has exactly this defect: `applyAction` updates `form`, it does NOT invalidate (measured in
   * `@sveltejs/kit@2.66.0`, `client.js:2566` — only `update()` calls `invalidateAll`).
   *
   * 🔴 `reset: false` FOR THE REASON THE PROMOTE FORM RECORDS: `update()` calls
   * `HTMLFormElement.reset()`, which restores each field's `defaultValue`, and Svelte writes
   * `element.value` and never `defaultValue`. The hidden `rows` input is Svelte-written, so a reset
   * would leave this form posting an EMPTY selection.
   *
   * The note is cleared here instead, on success only: after a refusal the operator keeps both it
   * and the selection, so a retry is not fifty checkboxes and a retyped sentence.
   */
  const bulkForm = new FormState({
    onSuccess: () => {
      note = '';
      onclear();
    },
    reload: true,
    reset: false,
  });
</script>

<!-- A spacer, so the fixed bar cannot cover the last row or the Next button.
     🔴 IT IS PAIRED WITH THIS BAR'S OWN HEIGHT AND IS NOT THE SIBLING QUEUES' `h-20`: this bar is
     taller, carrying a refusal row and a help paragraph they do not have. The three other selection
     bars in this app (`images/[slug]`, `images/to-ingest`, `images/tags`) each spell their own
     pair — if a shared shell is ever extracted it has to OWN the spacer/height pairing rather than
     inherit two magic numbers that only look like they match. -->
<div class="h-28"></div>

<div
  class="fixed inset-x-0 bottom-0 z-20 border-t border-dark-4 bg-dark-6/95 px-4 py-3 backdrop-blur"
>
  <div class="mx-auto flex max-w-6xl flex-col gap-2">
    {#if bulkForm.error}
      <ErrorAlert message={bulkForm.error} />
    {/if}
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-sm font-semibold text-white">
        {rows.length} selected
      </span>
      <!-- 🔴 DISABLED WHILE A SUBMIT IS IN FLIGHT. Clearing unmounts this bar, and the refusal for
           the request already on the wire lives in THIS component's `FormState` — so an operator who
           clears mid-flight would destroy the only thing that could tell them the action failed.
           `+page.svelte` carries a fallback for the same hazard reached by unticking rows. -->
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onclick={onclear}
        disabled={bulkForm.submitting}
        class="h-auto px-1 py-0 text-xs text-dark-2 hover:text-white"
      >
        Clear
      </Button>

      <form
        method="POST"
        action="?/bulkTriage"
        use:enhance={bulkForm.enhance}
        class="ml-auto flex flex-wrap items-center gap-2"
      >
        <!-- 🔴 One hidden input carrying id AND expected status per row. A bare id list would post
             past the per-row concurrency guard the single-row action enforces. -->
        <input type="hidden" name="rows" value={payload} />
        <!-- 🔴 `onkeydown` IS A GUARD, NOT AN ENHANCEMENT. A bulk action has no default verdict,
             but HTML implicit submission picks one anyway — the FIRST submit button, which is
             Reopen. See `blockImplicitBulkSubmit`. -->
        <!-- 🔴 `aria-label`, not `placeholder` alone: a placeholder stops being the accessible name
             the moment the operator types, and this is the field whose contents overwrite
             `triageNote` on up to fifty rows. -->
        <Input
          name="note"
          bind:value={note}
          onkeydown={blockImplicitBulkSubmit}
          aria-label="Triage note applied to every selected report"
          placeholder="Triage note (optional)"
          class="w-56"
          maxlength={5000}
        />
        {#each FEEDBACK_BULK_ACTIONS as action (action.status)}
          <Button
            type="submit"
            name="status"
            value={action.status}
            size="sm"
            variant="outline"
            disabled={bulkForm.submitting || rows.length === 0}
          >
            {action.label}
          </Button>
        {/each}
      </form>
    </div>
    <p class="text-xs text-dark-2">
      An empty note leaves every selected report's existing note alone. Reports already at the status
      you pick are skipped, and any a colleague has triaged since this page loaded are refused and
      reported back.
    </p>
  </div>
</div>

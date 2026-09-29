<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { dateTime } from '$lib/format';
  import { FEEDBACK_STATUSES, handledByLabel, type FeedbackContext } from '$lib/feedback';
  import { feedbackRefusal, type FeedbackFormName } from '$lib/feedback-refusal';
  import { makeFeedbackPromoteDraft } from '$lib/feedback-drafts';
  import FeedbackContextPanel from './FeedbackContextPanel.svelte';
  import FeedbackAttachments from './FeedbackAttachments.svelte';
  import FeedbackPromote from './FeedbackPromote.svelte';
  import type {
    FeedbackRow,
    FeedbackSibling,
    KnownIssueOption,
  } from '$lib/server/feedback.service';

  let {
    row,
    context,
    siblings,
    knownIssues,
    grafanaUrl,
    civitaiUrl,
    canTriage,
    canPromote,
  }: {
    row: FeedbackRow;
    context: FeedbackContext;
    siblings: FeedbackSibling[];
    /** Passed straight through to `FeedbackPromote`'s issue picker. */
    knownIssues: KnownIssueOption[];
    grafanaUrl: string | null;
    civitaiUrl: string;
    canTriage: boolean;
    canPromote: boolean;
  } = $props();

  /**
   * 🔴 `let`, NOT `const`, AND HANDED DOWN WITH `bind:draft=`. `FeedbackPromote` mutates this object
   * — four bound boxes and the mode toggle — and Svelte's dev ownership validator flags a mutation
   * of a prop the parent passed PLAIN: `is_bound_or_unset` wants a SETTER on the props descriptor
   * (`svelte@5.56.3/src/internal/client/dev/ownership.js:71-80`), and only `bind:` puts one there.
   * Unbound, every keystroke into title/summary/bugId/clickupUrl raised `ownership_invalid_mutation`;
   * measured at 2 warnings for 2 keystrokes in a compiled repro of this exact shape, 0 once bound.
   *
   * `const` is not an option alongside that binding — `bind:draft={promoteDraft}` over a `const` is
   * a COMPILE error (`constant_binding`), measured, not inferred. The `let` is therefore forced, and
   * it is not an invitation: nothing reassigns this, and `FeedbackPromote`'s own docstring says why
   * mutating in place remains the contract.
   *
   * 🔴 IT IS OWNED HERE, NOT IN `FeedbackPromote`, AND THE TABS GOING AWAY DID NOT REMOVE THE
   * REASON. Every successful write on this panel calls `invalidateAll()`, and a box declared inside
   * the child survives that only by accident; an issue title half-written when a triage save lands
   * is text the operator cannot get back. This component is the one that outlives the reload.
   */
  let promoteDraft = $state(makeFeedbackPromoteDraft());

  /**
   * Which form the operator submitted most recently — the tie-break when both have a live refusal.
   *
   * 🔴 IT IS NOT BOOKKEEPING. Both forms are on screen at once and each disables only its OWN submit
   * control, so a status click followed by a Create-issue click leaves two responses in flight and
   * can raise two refusals. Ranked by anything fixed, the banner shows the older one and the answer
   * the operator is actually waiting for never appears — the exact defect `feedbackRefusal`'s
   * docstring records. It used to be read off the URL's `?tab=`, which was only ever a proxy for
   * this.
   */
  let lastSubmitted = $state<FeedbackFormName | null>(null);

  /**
   * 🔴 `reset: false` ON BOTH FORMS. Neither carries a box seeded from the server any more, but both
   * carry HIDDEN inputs — `id` and `expectedStatus` here, `id` and `mode` in the promote form — and
   * Svelte writes `element.value`, never `defaultValue`. `HTMLFormElement.reset()` therefore blanks
   * them, and `set_value` early-returns on an unchanged expression, so nothing ever writes them
   * back: the next submit posts a form with no id and no concurrency guard at all.
   *
   * 🔴 `reload: true` because the panel RENDERS what these writes change — the status badge, the
   * handled-by line, the issue link. Without it a save lands and the panel goes on showing the
   * state it was saved from.
   */
  const triageForm = new FormState({
    onSuccess: null,
    reload: true,
    reset: false,
    onSubmit: () => {
      lastSubmitted = 'triage';
    },
  });

  /**
   * 🔴 OWNED HERE, NOT IN `FeedbackPromote`, so this panel can render one banner for both forms. It
   * is passed down as a prop — the form that submits still owns the `use:enhance`; only the STATE
   * moved up.
   */
  const promoteForm = new FormState({
    onSuccess: null,
    reload: true,
    reset: false,
    onSubmit: () => {
      lastSubmitted = 'promote';
    },
  });

  /**
   * 🔴 ONE BANNER, ABOVE EVERY SECTION. Both forms are on screen now, so a refusal rendered inside
   * the section that raised it would also be correct — but a reader scrolled to the bottom of a long
   * report would have to find it, and two banners in one panel is how the queue has double-rendered
   * a refusal before. WHICH message it shows when two are live is `feedbackRefusal`'s decision, not
   * this file's; it is a pure function so it can be tested, because this app has no Svelte tier.
   */
  const refusal = $derived(
    feedbackRefusal({ triage: triageForm.error, promote: promoteForm.error }, lastSubmitted)
  );
</script>

<!-- `min-w-0` at every level: on the queue this panel lives inside a `<td colspan=9>` of a table
     whose own container scrolls horizontally, so without it a long unbroken path or session id
     widens the TABLE instead of wrapping inside the panel. -->
<div class="flex min-w-0 flex-col gap-5 p-5 text-left">
  {#if refusal}
    <ErrorAlert message={refusal} />
  {/if}

  <!-- 🔴 THE MESSAGE AND ITS ATTACHMENTS ARE ONE CLAIM — "this looked wrong" plus the picture of it
       — and reading them together is the whole triage step. They were split behind separate tabs
       once; that cost two navigations for a pairing that previously cost none. -->
  <section class="flex min-w-0 flex-col gap-3">
    <h3 class="text-xs tracking-wide text-dark-2 uppercase">Report</h3>
    <p class="wrap-break-word text-sm whitespace-pre-wrap">{row.message}</p>
    <FeedbackAttachments {context} />
  </section>

  <!-- `FeedbackContextPanel` renders several sibling sections, so the wrapper supplies the column
       and the gap they sit in. -->
  <div class="flex min-w-0 flex-col gap-4 border-t border-dark-4 pt-5">
    <FeedbackContextPanel
      area={row.area}
      {context}
      createdAt={row.createdAt}
      {civitaiUrl}
      {grafanaUrl}
    />
  </div>

  <div class="min-w-0 border-t border-dark-4 pt-5">
    <FeedbackPromote
      {row}
      {siblings}
      {knownIssues}
      {civitaiUrl}
      {canPromote}
      form={promoteForm}
      bind:draft={promoteDraft}
    />
  </div>

  <!-- 🔴 A FOOTER, NOT A SECTION IN THE STACK. The verdict is the one control an operator reaches
       for on every report, and it has to be reachable without reading past a JSON dump and an issue
       form to find it. -->
  <footer class="flex min-w-0 flex-col gap-2 border-t border-dark-4 pt-4">
    {#if canTriage}
      <form method="POST" action="?/triage" use:enhance={triageForm.enhance}>
        <input type="hidden" name="id" value={row.id} />
        <!-- 🔴 The status the operator is LOOKING AT rides along, and the UPDATE is scoped on it.
             Without it a second moderator's verdict silently overwrites the first. -->
        <input type="hidden" name="expectedStatus" value={row.status} />

        <!-- 🔴 THIS FORM POSTS NO `note`, AND THE SERVER MUST KEEP TREATING THAT AS "LEAVE THE
             COLUMN ALONE". `Feedback.triageNote` still holds notes written before the box was
             removed, and reading an absent field as an empty one would destroy one of them on every
             status click. The distinction is enforced in `$lib/server/feedback-actions.ts` and in
             `triageFeedback`'s signature. -->
        <div class="flex flex-wrap gap-2">
          {#each FEEDBACK_STATUSES as status (status)}
            <Button
              type="submit"
              name="status"
              value={status}
              size="sm"
              variant={status === row.status ? 'default' : 'outline'}
              disabled={triageForm.submitting}
            >
              {status === row.status ? `Save (${status})` : status}
            </Button>
          {/each}
        </div>
      </form>
    {:else}
      <p class="text-sm text-dark-2">
        You can read this queue but not triage it — that needs the “Set feedback status and triage
        notes” permission.
      </p>
    {/if}

    {#if row.handledAt}
      <p class="text-xs text-dark-2">
        Handled by {handledByLabel(row)} on {dateTime(row.handledAt)}
      </p>
    {/if}
  </footer>
</div>

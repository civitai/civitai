<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { dateTime } from '$lib/format';
  import { FEEDBACK_STATUSES, handledByLabel, type FeedbackContext } from '$lib/feedback';
  import { feedbackRefusal, type FeedbackFormName } from '$lib/feedback-refusal';
  import { feedbackPanelHasUnsavedDraft, makeFeedbackPromoteDraft } from '$lib/feedback-drafts';
  import { feedbackTechnicalSummary } from '$lib/feedback-technical-summary';
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
    formError = null,
    draftDirty = $bindable(false),
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
    /**
     * 🔴 THE NO-JS SURFACE, and only that: the page-level `form.error`, for a route whose panel is
     * always mounted. Without JS a refused POST re-renders the page with `form` populated and both
     * `FormState`s null — nothing else on screen would say the save was refused.
     *
     * 🔴 IT IS THE LAST RESORT IN ONE BANNER, NOT A SECOND BANNER. `use:enhance` sets the page-level
     * `form` as well as `FormState.error`, so an unconditional page-level `ErrorAlert` renders the
     * same refusal twice — this queue has double-rendered a refusal three times, and no instance was
     * visible to any test, because this app has no browser tier.
     *
     * 🔴 IT IS ALSO GATED ON `lastSubmitted === null`, AND THAT GATE IS NOT BELT-AND-BRACES. The
     * page-level `form` is not replaced until a response lands, so between an enhanced submit
     * clearing the other form's error and that response arriving, a bare `?? formError` re-renders
     * the refusal the submit just cleared — for the whole in-flight window. `lastSubmitted` is
     * written only by `use:enhance`'s `onSubmit`, so it is null exactly while this instance has
     * never run an enhanced submit: the server-rendered case this prop exists for, and no other.
     *
     * The QUEUE passes nothing and keeps its own `pageError` instead: there the panel is mounted
     * only while a row is open, so a no-JS POST lands on a page with no panel at all and the message
     * has to live above the table. The two surfaces stay disjoint.
     *
     * ⚠️ THE GATE RESTS ON EVERY FORM IN THIS PANEL OWNING A `FormState`. `lastSubmitted` never
     * returns to null once written, so a third form added with a bare `use:enhance` would land its
     * refusal in the page-level `form` alone — where this gate then suppresses it for the life of the
     * component. Give any new form a `FormState`, or this prop stops covering it.
     */
    formError?: string | null;
    /**
     * 🔴 REPORTED UPWARD SO THE QUEUE CAN REFUSE TO UNMOUNT THIS PANEL OVER UNSAVED TEXT. The row
     * click that expands a report destroys whatever panel is open, and `promoteDraft` is held in
     * this component's memory and nowhere else — but the click handler lives in `+page.svelte`,
     * outside this component, so the fact has to leave it. The QUEUE passes `bind:`; the per-report
     * page does not, because it has no rows to click.
     *
     * 🔴 IT IS A `$bindable` WRITTEN FROM AN `$effect`, AND THAT IS NOT THE `$effect` THE STANDARD
     * FORBIDS. The banned shape fetches and assigns to `$state`; this one propagates a value that is
     * DERIVED here and CONSUMED one level up, and Svelte has no downward-declared-upward-flowing
     * derived. `$derived` cannot write a prop, and a plain prop the child mutates raises
     * `ownership_invalid_mutation` — the defect `promoteDraft` already documents at length.
     *
     * It only ever writes, never reads, so there is no loop.
     */
    draftDirty?: boolean;
  } = $props();

  /** The `<summary>` badge — what the collapsed block holds, without opening it. */
  const technicalSummary = $derived(feedbackTechnicalSummary(context));

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

  // The one fact the queue needs about this panel, kept in step with the draft AND with the row —
  // a linked report renders no promote form, so its draft is text nothing can still reach. See the
  // `draftDirty` prop for why this is an effect rather than a `$derived`.
  $effect(() => {
    draftDirty = feedbackPanelHasUnsavedDraft(row, promoteDraft);
  });

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
  /**
   * 🔴 `onSubmit` CLEARS THE OTHER FORM'S ERROR, AND THAT IS A TRADE, NOT A FREE WIN — kept from
   * before the tabs went away, because removing it made a worse failure. Without it a promote
   * refusal outlives a triage save that SUCCEEDED: `feedbackRefusal`'s fallback re-renders the old
   * red banner over a save that worked, this panel has no success indicator to contradict it, and
   * the operator's likeliest response is to click the status button again.
   *
   * ⚠️ What it costs, stated rather than left to be discovered: the clear happens at submit START
   * and does not care how this submit ENDS, so a standing promote refusal is discarded by an
   * unrelated triage save, leaving a pre-filled promote form and nothing explaining why. That
   * direction is the worse one to lose, and it is the one kept — the alternative above is a banner
   * that actively contradicts what just happened.
   *
   * ⚠️ IT DOES NOT MAKE TWO LIVE REFUSALS IMPOSSIBLE. It narrows the common orderings; each form
   * disables only its OWN submit control, so two responses can still be in flight together.
   * `lastSubmitted` is what has to be correct when they are.
   */
  const triageForm = new FormState({
    onSuccess: null,
    reload: true,
    reset: false,
    onSubmit: () => {
      lastSubmitted = 'triage';
      promoteForm.error = null;
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
      triageForm.error = null;
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
    feedbackRefusal({ triage: triageForm.error, promote: promoteForm.error }, lastSubmitted) ??
      (lastSubmitted === null ? formError : null)
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

  <!-- 🔴 NOT `{#if}`. `<details>` hides its content; it does not UNMOUNT it. The tab strip this panel
       used to carry destroyed the inactive sections' markup — the reason every operator-typed box
       here is bound to parent-owned state — and the tripwire written against that
       (`renders every section unconditionally`) matches on `activeTab` by name, so an `{#if}`
       collapse walks straight past it. Nothing in this block is operator-typed today, so the cost
       would not surface until something is.

       🔴 `theme.css` styles `summary { cursor: pointer }` already — do NOT add `cursor-pointer`.
       Several summaries in this app add it anyway.

       The inner wrapper supplies the column and gap `FeedbackContextPanel`'s sibling sections sit
       in. -->
  <details class="min-w-0 border-t border-dark-4 pt-5">
    <!-- 🔴 The badge is the only thing that survives the collapse, so it must not become a second
         place the counts are spelled: `feedbackTechnicalSummary` owns the wording, and "distinct"
         in it is load-bearing — see its docstring. -->
    <summary class="text-xs tracking-wide text-dark-2 uppercase">
      Technical details
      {#if technicalSummary}
        <span class="ml-2 font-normal normal-case">{technicalSummary}</span>
      {/if}
    </summary>
    <div class="mt-4 flex min-w-0 flex-col gap-4">
      <FeedbackContextPanel
        area={row.area}
        {context}
        createdAt={row.createdAt}
        {civitaiUrl}
        {grafanaUrl}
      />
    </div>
  </details>

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
             COLUMN ALONE" rather than as an empty note. Enforced in
             `$lib/server/feedback-actions.ts` and in `triageFeedback`'s signature.

             ⚠️ IT GUARDS THE CONTRACT, NOT EXISTING DATA — measured, so nobody overstates it later:
             production holds 47 `Feedback` rows and `triageNote` is non-null on ZERO of them. There
             is nothing to destroy today and no writer left to create more. What the distinction
             buys is that a future writer — a backfill, an import, a note box that comes back — does
             not find a status click quietly blanking its column. -->
        <!-- 🔴 THE CURRENT STATUS IS DISABLED, AND IT USED TO READ `Save (<status>)`. That button
             had a job while this form carried the internal-note textarea: it persisted the note
             without moving the row. With the note gone it submits a status change to the status the
             row already has — `expectedStatus === status`, so the UPDATE matches, and
             `triageFeedback` reassigns `handledById`/`handledAt` to whoever clicked and writes a
             `ModActivity` row. The queue's Handled column then credits a moderator who only clicked
             through, over the one who actually ruled, with nothing recording that it changed. -->
        <div class="flex flex-wrap gap-2">
          {#each FEEDBACK_STATUSES as status (status)}
            <Button
              type="submit"
              name="status"
              value={status}
              size="sm"
              variant={status === row.status ? 'default' : 'outline'}
              disabled={triageForm.submitting || status === row.status}
            >
              {status}
            </Button>
          {/each}
        </div>
      </form>
    {:else}
      <p class="text-sm text-dark-2">
        You can read this queue but not triage it — that needs the “Set feedback status”
        permission.
      </p>
    {/if}

    {#if row.handledAt}
      <p class="text-xs text-dark-2">
        Handled by {handledByLabel(row)} on {dateTime(row.handledAt)}
      </p>
    {/if}
  </footer>
</div>

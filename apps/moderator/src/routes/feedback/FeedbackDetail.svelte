<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { dateTime } from '$lib/format';
  import { FEEDBACK_STATUSES, handledByLabel, type FeedbackContext } from '$lib/feedback';
  import { feedbackTabFromUrl, type FeedbackTab } from '$lib/feedback-tabs';
  import { feedbackRefusal } from '$lib/feedback-refusal';
  import { makeFeedbackPromoteDraft } from '$lib/feedback-drafts';
  import FeedbackTabs from './FeedbackTabs.svelte';
  import FeedbackContextPanel from './FeedbackContextPanel.svelte';
  import FeedbackAttachments from './FeedbackAttachments.svelte';
  import FeedbackPromote from './FeedbackPromote.svelte';
  import type { FeedbackRow, FeedbackSibling } from '$lib/server/feedback.service';

  let {
    row,
    context,
    siblings,
    grafanaUrl,
    civitaiUrl,
    canTriage,
    canPromote,
  }: {
    row: FeedbackRow;
    context: FeedbackContext;
    siblings: FeedbackSibling[];
    grafanaUrl: string | null;
    civitaiUrl: string;
    canTriage: boolean;
    canPromote: boolean;
  } = $props();

  /**
   * 🔴 EVERY TYPED-INTO BOX IN THIS PANEL IS OWNED HERE, BECAUSE THIS COMPONENT IS THE ONLY PART OF
   * IT THAT SURVIVES A TAB CLICK. The tabs are links, so a click is a real navigation; `load`
   * re-runs and the panel's `{#if activeTab === …}` chain destroys the branch that was showing. This
   * component is NOT destroyed — `+page.svelte`'s `{#each … (row.id)}` is keyed and the row's
   * `{#if open}` never goes false, so props update on the same instance — which is exactly why the
   * drafts belong at this level and nowhere below it.
   *
   * Before this, the note box was an unbound `value={row.triageNote ?? ''}` and the issue boxes were
   * uncontrolled: what the operator had typed lived only in DOM nodes, and the branch took those
   * nodes with it. Reading the report, opening Context to check a claim, and coming back to finish
   * the note silently reverted the note to the stored column. The likeliest moment to hit it is
   * right after a 409 — read the banner, flip a tab to check, come back to fix and resubmit — which
   * is the very text `FormState`'s `reset: false` exists to protect.
   *
   * ⚠️ WHAT THIS TRADES AWAY, stated rather than left to be discovered: the box now follows the
   * operator's draft, so a note another moderator changed under them is no longer picked up by the
   * reload that a tab click triggers. Their draft shadows it until they save, and that save is
   * last-write-wins exactly as it already was — the `expectedStatus` guard covers the STATUS race,
   * never this column. Losing someone else's concurrent edit at the moment you save is the smaller
   * harm than losing your own text every time you look at another tab.
   *
   * 🔴 `state_referenced_locally` IS SUPPRESSED DELIBERATELY, AND CAPTURING ONLY THE INITIAL VALUE
   * IS THE POINT — a draft that re-derived itself from `row` would be destroyed by the same reload
   * this block exists to survive, so the warning's premise (you probably wanted `$derived`) is the
   * opposite of what is wanted here.
   *
   * It is safe because this instance is scoped to ONE row and cannot be handed another: the row's
   * `{#if open}` in `+page.svelte` is false for every row but the open one, so opening a different
   * report destroys this component and builds a new one. `row.id` is therefore fixed for the life of
   * the instance, and the only thing that can change under it is the stored note — which
   * `triageForm.onSuccess` re-reads explicitly after its own save.
   */
  // svelte-ignore state_referenced_locally
  let note = $state(row.triageNote ?? '');
  const promoteDraft = $state(makeFeedbackPromoteDraft());

  /**
   * 🔴 `reset: false`. The note box is pre-filled from the COLUMN, and a reset blanks it — the
   * operator's next status click would then post an empty note and destroy the stored one, with a
   * green screen over it. (It no longer depends on the bound expression CHANGING to repopulate,
   * which is what made the old unbound `value=` fragile: `onSuccess` now re-seeds `note` from the
   * reloaded column explicitly, and `reload: true` is what guarantees that column is the fresh one —
   * `update({ invalidateAll })` is awaited before `onSuccess` runs.)
   *
   * 🔴 `onSubmit` CLEARS THE OTHER FORM'S ERROR. Two refusals could otherwise be live at once — a
   * refused triage, then a refused promote on another tab — and one banner can only say one of them.
   * Clearing at submit time is what makes "at most one live error" true rather than asserted: the
   * only thing that SETS an error is a response to a submit, and every submit starts by clearing its
   * counterpart. It also kills the quieter half of the same bug, where a SUCCESSFUL promote left the
   * older triage banner on screen reading as current.
   */
  const triageForm = new FormState({
    onSuccess: () => {
      note = row.triageNote ?? '';
    },
    reload: true,
    reset: false,
    onSubmit: () => {
      promoteForm.error = null;
    },
  });

  /**
   * 🔴 `reset: false`, matching the triage form, for the reason spelled out in `FeedbackPromote`:
   * that form carries hidden `id`/`mode` inputs and Svelte writes their `value` rather than
   * `defaultValue`, so a reset would leave a form posting neither.
   *
   * 🔴 OWNED HERE, NOT IN `FeedbackPromote`, so this panel can render its refusal. It is passed down
   * as a prop — the form that submits still owns the `use:enhance`; only the STATE moved up, which is
   * the minimum that lets one banner speak for both forms. `promoteDraft` moved up for the separate
   * reason above; they are two different problems that happen to have the same answer.
   *
   * Referencing `triageForm` from this closure is safe despite the declaration order: `onSubmit` is
   * called when a submit starts, long after both `const`s are initialised.
   */
  const promoteForm = new FormState({
    onSuccess: null,
    reload: true,
    reset: false,
    onSubmit: () => {
      triageForm.error = null;
    },
  });

  const activeTab = $derived<FeedbackTab>(feedbackTabFromUrl(page.url));

  /**
   * 🔴 REFUSALS RENDER ABOVE THE TAB STRIP, NOT INSIDE THE SECTION THAT RAISED THEM — and this is the
   * decision tabs forced. Before tabs, `triageForm.error` and `promoteForm.error` rendered inside
   * their own sections and both sections were always on screen, so a refusal could not be missed. Put
   * a form behind a tab and that stops being true: a 409 raised by the triage form while the operator
   * is reading Context would land on a panel nobody is looking at, and the operator would see a
   * submit that appeared to do nothing.
   *
   * The alternative — auto-switching to the owning tab — was rejected. Switching tabs here is a
   * NAVIGATION (see `FeedbackTabs.svelte`), and `update()` re-runs `load` on SUCCESS only, so firing
   * a navigation on a refusal would re-run `load` at exactly the moment SvelteKit deliberately does
   * not, racing the state that holds the message against the reload that would discard it.
   *
   * A panel-level banner has neither problem: it is mounted whenever the panel is, on whatever tab.
   * It NAMES the owning tab when that is not the current one, so "your save was refused" also says
   * where to go and fix it.
   *
   * WHICH message it shows when two are somehow live is `feedbackRefusal`'s decision, not this
   * file's — it is in `$lib/feedback-refusal.ts` so it can be tested, and its docstring carries both
   * the rule and the retraction of the claim that used to sit here.
   */
  const refusal = $derived(
    feedbackRefusal({ triage: triageForm.error, promote: promoteForm.error }, activeTab)
  );
</script>

<!-- `min-w-0` at every level: this panel lives inside a `<td colspan=9>` of a table whose own
     container scrolls horizontally, so without it a long unbroken path or session id widens the
     TABLE instead of wrapping. -->
<div class="flex min-w-0 flex-col gap-4 p-5 text-left">
  {#if refusal}
    <ErrorAlert message={refusal} />
  {/if}

  <FeedbackTabs active={activeTab} />

  <!-- Only the selected tab is rendered: the containment model on this page is that nothing loads
       until a moderator asks for it, and a hidden-but-mounted panel is a weaker claim than one that
       was never built.

       🔴 SO THIS CHAIN GENUINELY DESTROYS MARKUP, AND THE DRAFTS ARE WHAT PAYS FOR IT. Nothing
       below this line may hold text the operator typed — it must live in the `$state` declared
       above, which outlives the branch. Adding a box to any branch means adding it to a draft.

       🔴 ATTACHMENTS RENDER WITH THE MESSAGE, ON THE DEFAULT TAB — not behind a tab of their own.
       "This looked wrong" and the picture of it are one claim, and reading them together is the
       whole triage step; splitting them cost two navigations for a pairing that previously cost
       none. The containment argument for splitting them does not survive: thumbnails already only
       mount once the ROW is expanded, so a tab in front of them bought a second gate on top of an
       existing one, not a first gate. Row expansion is still the containment. -->
  {#if activeTab === 'message'}
    <p class="wrap-break-word text-sm whitespace-pre-wrap">{row.message}</p>
    <FeedbackAttachments {context} />
  {:else if activeTab === 'context'}
    <FeedbackContextPanel
      area={row.area}
      {context}
      createdAt={row.createdAt}
      {civitaiUrl}
      {grafanaUrl}
    />
  {:else if activeTab === 'triage'}
    <section class="flex min-w-0 flex-col gap-3">
      <h3 class="text-xs tracking-wide text-dark-2 uppercase">Triage</h3>

      {#if canTriage}
        <form
          method="POST"
          action="?/triage"
          use:enhance={triageForm.enhance}
          class="flex flex-col gap-3"
        >
          <input type="hidden" name="id" value={row.id} />
          <!-- 🔴 The status the operator is LOOKING AT rides along, and the UPDATE is scoped on it.
               Without it a second moderator's verdict silently overwrites the first. -->
          <input type="hidden" name="expectedStatus" value={row.status} />

          <div class="flex flex-col gap-1">
            <Label for={`note-${row.id}`} class="text-xs text-dark-2">
              Internal note — never seeded into an issue
            </Label>
            <!-- 🔴 `bind:value`, NOT `value=`. Every status click rewrites this column, so the box
                 has to carry the stored note — but it also has to carry what is being TYPED into it
                 across a tab click that destroys this markup, and an unbound `value=` keeps that
                 text in the DOM node alone. `note` is seeded from the column and re-seeded from it
                 on a successful save; see the declaration. -->
            <Textarea id={`note-${row.id}`} name="note" rows={2} bind:value={note} />
          </div>

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
    </section>
  {:else if activeTab === 'issue'}
    <FeedbackPromote
      {row}
      {siblings}
      {civitaiUrl}
      {canPromote}
      form={promoteForm}
      draft={promoteDraft}
    />
  {/if}
</div>

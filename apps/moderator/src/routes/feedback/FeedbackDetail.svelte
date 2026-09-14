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
  import {
    FEEDBACK_FORM_TAB,
    feedbackTabFromUrl,
    feedbackTabLabel,
    type FeedbackTab,
  } from '$lib/feedback-tabs';
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
   * 🔴 `reset: false`. The note box is pre-filled from the COLUMN, and a reset blanks it without
   * repopulating — the bound expression is unchanged by a status-only save, so Svelte does not
   * rewrite it. The operator's next status click would then post an empty note and destroy the
   * stored one, with a green screen over it.
   */
  const triageForm = new FormState({ onSuccess: null, reload: true, reset: false });

  /**
   * 🔴 `reset: false`, matching the triage form, for the reason spelled out in `FeedbackPromote`:
   * that form carries hidden `id`/`mode` inputs and Svelte writes their `value` rather than
   * `defaultValue`, so a reset would leave a form posting neither.
   *
   * 🔴 OWNED HERE, NOT IN `FeedbackPromote`, so this panel can render its refusal. It is passed down
   * as a prop — the form that submits still owns the `use:enhance`; only the STATE moved up, which is
   * the minimum that lets one banner speak for both forms.
   */
  const promoteForm = new FormState({ onSuccess: null, reload: true, reset: false });

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
   * Triage wins when both are set. They cannot be: each form disables its own controls while
   * submitting, and a success clears the error. The order is a tiebreak, not a policy.
   */
  const refusal = $derived.by(() => {
    const raised = triageForm.error
      ? { message: triageForm.error, tab: FEEDBACK_FORM_TAB.triage }
      : promoteForm.error
        ? { message: promoteForm.error, tab: FEEDBACK_FORM_TAB.promote }
        : null;
    if (!raised) return null;
    return raised.tab === activeTab
      ? raised.message
      : `${raised.message} (on the ${feedbackTabLabel(raised.tab)} tab)`;
  });
</script>

<!-- `min-w-0` at every level: this panel lives inside a `<td colspan=9>` of a table whose own
     container scrolls horizontally, so without it a long unbroken path or session id widens the
     TABLE instead of wrapping. -->
<div class="flex min-w-0 flex-col gap-4 p-5 text-left">
  {#if refusal}
    <ErrorAlert message={refusal} />
  {/if}

  <FeedbackTabs active={activeTab} />

  <!-- Only the selected tab is rendered. That is deliberate for Attachments in particular: the
       containment model on this page is that nothing loads until a moderator asks for it, and a
       hidden-but-mounted panel is a weaker claim than one that was never built. -->
  {#if activeTab === 'message'}
    <p class="wrap-break-word text-sm whitespace-pre-wrap">{row.message}</p>
  {:else if activeTab === 'context'}
    <FeedbackContextPanel
      area={row.area}
      {context}
      createdAt={row.createdAt}
      {civitaiUrl}
      {grafanaUrl}
    />
  {:else if activeTab === 'attachments'}
    <FeedbackAttachments {context} />
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
            <!-- Every status click rewrites this column, so the box must always carry the stored note. -->
            <Textarea id={`note-${row.id}`} name="note" rows={2} value={row.triageNote ?? ''} />
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
    <FeedbackPromote {row} {siblings} {civitaiUrl} {canPromote} form={promoteForm} />
  {/if}
</div>

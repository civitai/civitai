<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import { reasonRequiresNote } from '@civitai/shared/resolution-reasons';
  import type { RulingDraft } from '$lib/components/RulingForm.svelte';
  import InlineReasonFields from '$lib/components/triage/InlineReasonFields.svelte';
  import ReasonPicker from '$lib/components/triage/ReasonPicker.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import { rulingLabel } from '$lib/restrictions/verdict-label';
  import {
    RESTRICTION_DECISIONS,
    restrictionDecisionReasons,
    restrictionEffectiveReason,
    restrictionRulingRefusal,
    type RestrictionVerdict,
  } from '$lib/restrictions/ruling-decisions';
  import { clickDecision } from '$lib/triage/decision-form';
  import type { Outcome } from '$lib/triage/queue';
  import {
    noteReasonChosen,
    openReasonPicker,
    reasonPicker,
    resetReasonPicker,
  } from '$lib/triage/reason-picker.svelte';

  let {
    restrictionId,
    unwiredReason,
    hint,
    submit,
    actionHref,
    extras,
    draft = $bindable(),
  }: {
    restrictionId: number;
    /** Why no ruling can be recorded for this type; disables both decisions. */
    unwiredReason: string | null | undefined;
    hint: string;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    /** More buttons on the decision row: the ban and the false-positive flag. */
    extras?: Snippet;
    draft: RulingDraft<RestrictionVerdict>;
  } = $props();

  const verdictIndex = $derived(RESTRICTION_DECISIONS.findIndex((d) => d.verdict === draft.verdict));
  const reasons = $derived(draft.verdict ? restrictionDecisionReasons(draft.verdict) : []);
  const reason = $derived(draft.verdict ? restrictionEffectiveReason(draft.verdict, draft.reason) : '');
  // Only the chosen verdict's reasons: the reason is picked after the verdict here.
  const reasonOptions = $derived({ groups: [], shared: reasons });
  let problem = $state<string | null>(null);
  let reasonSelect = $state<HTMLElement | null>(null);
  let noteInput = $state<HTMLInputElement | null>(null);

  // A verdict key or click selects its decision and opens its reasons; clearing the verdict (a row
  // change, or the key pressed twice) takes the list with it.
  $effect(() => {
    const index = verdictIndex;
    if (index >= 0) openReasonPicker(index);
    else resetReasonPicker();
  });
  $effect(() => () => resetReasonPicker());

  const select = (verdict: RestrictionVerdict) => {
    if (draft.verdict === verdict) return;
    draft = { verdict, reason: '', note: '' };
    problem = null;
  };

  // The first press of a decision only selects it; the next confirms, unless the reason or note
  // cannot be recorded, in which case nothing is sent and the bar says why.
  const decide: SubmitFunction = async (input) => {
    const posted = input.formData.get('status') as RestrictionVerdict | null;
    if (!posted || !RESTRICTION_DECISIONS.some((d) => d.verdict === posted)) {
      input.cancel();
      return;
    }
    if (posted !== draft.verdict) {
      input.cancel();
      select(posted);
      return;
    }
    const refusal = unwiredReason ?? restrictionRulingRefusal(posted, reason, draft.note);
    if (refusal) {
      input.cancel();
      problem = refusal;
      if (!unwiredReason) reasonSelect?.focus();
      return;
    }
    problem = null;
    resetReasonPicker();
    return submit(rulingLabel(input.formData))(input);
  };
</script>

{#snippet decisionButtons()}
  {#each RESTRICTION_DECISIONS as d, i (d.verdict)}
    <TriageKeyButton
      type="submit"
      key={i + 1}
      primary={i === 0}
      reasons
      selected={draft.verdict === d.verdict}
      name="status"
      value={d.verdict}
      disabled={!!unwiredReason}
      title={unwiredReason ?? undefined}
    >
      {d.label}
    </TriageKeyButton>
  {/each}
  {@render extras?.()}
{/snippet}

{#snippet picker()}
  {#if reasonPicker.open !== null && RESTRICTION_DECISIONS[reasonPicker.open]}
    <ReasonPicker
      index={reasonPicker.open}
      label={RESTRICTION_DECISIONS[reasonPicker.open].label}
      reasons={restrictionDecisionReasons(RESTRICTION_DECISIONS[reasonPicker.open].verdict)}
      current={reason}
      note={draft.note}
      onreason={(next) => {
        draft = { ...draft, reason: next };
        problem = null;
      }}
      onneednote={() => noteInput?.focus()}
    />
  {/if}
{/snippet}

{#snippet fields()}
  <InlineReasonFields
    compact
    options={reasonOptions}
    bind:reason={
      () => reason,
      (next) => {
        draft = { ...draft, reason: next };
        problem = null;
        noteReasonChosen(reasonRequiresNote(next));
      }
    }
    bind:note={
      () => draft.note,
      (next) => {
        draft = { ...draft, note: next };
        problem = null;
      }
    }
    bind:select={reasonSelect}
    bind:noteInput
    onenter={() => clickDecision(verdictIndex)}
  />
{/snippet}

<!-- One form, one button per verdict: each button posts the `status` it rules. -->
<form method="POST" action={actionHref('resolve')} use:enhance={decide} class="w-full">
  <input type="hidden" name="userRestrictionId" value={restrictionId} />
  <TriageDecisionBar
    compact
    buttons={decisionButtons}
    picker={reasonPicker.open !== null ? picker : undefined}
    fields={draft.verdict ? fields : undefined}
    {problem}
    {hint}
  />
</form>

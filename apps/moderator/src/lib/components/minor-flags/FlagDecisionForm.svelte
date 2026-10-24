<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { reasonRequiresNote, type ResolutionVerdict } from '@civitai/shared/resolution-reasons';
  import type { RulingDraft } from '$lib/components/RulingForm.svelte';
  import ReasonPicker from '$lib/components/triage/ReasonPicker.svelte';
  import InlineReasonFields from '$lib/components/triage/InlineReasonFields.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import {
    decisionEnabled,
    decisionReasonList,
    flaggedReasonGroups,
    planDecision,
    planReasonProblem,
    routesThroughAppeal,
    type FlagRef,
    type FlaggedDecision,
  } from '$lib/minor-flags/flagged-decision';
  import { decisionReasonOptions, suggestedReason } from '$lib/triage/decision-reasons';
  import {
    closeReasonPickerBeyond,
    noteReasonChosen,
    reasonPicker,
    resetReasonPicker,
    submitAwaitingNote,
  } from '$lib/triage/reason-picker.svelte';
  import type { Outcome } from '$lib/triage/queue';

  type Verdict = ResolutionVerdict<'heldDetection'> | ResolutionVerdict<'flagReview'>;

  let {
    modelId,
    flags,
    decisions,
    hasPendingAppeal,
    canRuleAppeals = true,
    submit,
    actionHref,
    hint,
    draft = $bindable(),
  }: {
    modelId: number;
    flags: FlagRef[];
    /** In key order: digit `n + 1` picks index `n`. */
    decisions: FlaggedDecision[];
    hasPendingAppeal: boolean;
    /** Whether the viewer holds the Appeals tab, which ruling through an appeal needs. */
    canRuleAppeals?: boolean;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    /** Under the bar while a reason select shows. */
    hint: string;
    draft: RulingDraft<Verdict>;
  } = $props();

  // Change with `flaggedDecisionEnabled`.
  const APPEAL_FIRST = "Resolve the owner's open appeal first.";
  const APPEALS_ACCESS = 'Rule this from Appeals: you need access to the Appeals tab.';

  const withAppeal = $derived(flags.map((f) => ({ ...f, hasPendingAppeal, canRuleAppeals })));
  const enabled = $derived(decisions.map((d) => decisionEnabled(withAppeal, d)));
  const viaAppeal = $derived(routesThroughAppeal(flags, hasPendingAppeal));
  const unavailable = $derived(viaAppeal && !canRuleAppeals ? APPEALS_ACCESS : APPEAL_FIRST);
  const reasonGroups = $derived(
    flaggedReasonGroups(flags, { keep: decisions[0].label, revert: decisions[1].label }, viaAppeal)
  );
  const reasonOptions = $derived(reasonGroups ? decisionReasonOptions(reasonGroups) : null);
  // Key 1 takes one press when it has a single specific reason.
  const suggested = $derived(
    enabled[0] && reasonGroups ? suggestedReason(reasonGroups[0].reasons) : ''
  );
  const reason = $derived(draft.reason || suggested);
  let problem = $state<string | null>(null);
  let reasonSelect = $state<HTMLElement | null>(null);
  let noteInput = $state<HTMLInputElement | null>(null);
  const reasonsFor = (i: number) =>
    reasonGroups ? decisionReasonList(reasonGroups, decisions[i], flags.length) : [];

  // The list and its wait for a note belong to this bar: a row or tab change must not leave them for
  // the next one, and a re-derive can drop the decision the list is open on.
  $effect(() => () => resetReasonPicker());
  $effect(() => closeReasonPickerBeyond(decisions.length));

  const outcomeOf = (keep: string[]) =>
    keep.length === flags.length ? 'Flagged' : keep.length === 0 ? 'Not flagged' : 'Split';

  // One step: the decision button submits with the reason and note already in the bar, unless they
  // cannot be recorded for that decision, in which case nothing is sent and the bar says why.
  const decide: SubmitFunction = async (input) => {
    resetReasonPicker();
    const posted = input.formData.get('keep');
    const index = decisions.findIndex((d) => d.keep.join(',') === posted);
    const refusal =
      index < 0
        ? 'Pick a decision.'
        : !enabled[index]
          ? unavailable
          : planReasonProblem(
              planDecision(flags, decisions[index].keep),
              decisions[index].label,
              reason,
              draft.note,
              viaAppeal
            );
    if (refusal) {
      input.cancel();
      problem = refusal;
      if (!(refusal === APPEAL_FIRST || refusal === APPEALS_ACCESS)) reasonSelect?.focus();
      return;
    }
    problem = null;
    const finish = await submit(outcomeOf(decisions[index].keep))(input);
    return async (result) => {
      await finish?.(result);
      // Some flags were ruled before one failed, or the action died and nobody knows: reload so the
      // row shows only what is still waiting. A refusal stays on the page's form as the banner.
      if (
        result.result.type === 'error' ||
        (result.result.type === 'failure' && result.result.data?.partial === true)
      )
        await invalidateAll();
    };
  };
</script>

{#snippet decisionButtons()}
  {#each decisions as d, i (d.keep.join(','))}
    {@const why = !enabled[i] ? unavailable : null}
    <TriageKeyButton
      type="submit"
      key={i + 1}
      primary={i === 0}
      reasons={reasonsFor(i).length > 0}
      name="keep"
      value={d.keep.join(',')}
      formaction={actionHref('decideFlags')}
      disabled={!!why}
      title={why ?? undefined}
    >
      {d.label}
    </TriageKeyButton>
  {/each}
{/snippet}

{#snippet picker()}
  {#if reasonPicker.open !== null && decisions[reasonPicker.open]}
    <ReasonPicker
      index={reasonPicker.open}
      label={decisions[reasonPicker.open].label}
      reasons={reasonsFor(reasonPicker.open)}
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
  {#if reasonOptions}
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
      onenter={() => submitAwaitingNote(decisions.length)}
    />
  {/if}
{/snippet}

<!-- One form, one button per decision: each button posts the flags it keeps. -->
<form method="POST" action={actionHref('decideFlags')} use:enhance={decide} class="w-full">
  <input type="hidden" name="modelId" value={modelId} />
  <input type="hidden" name="flags" value={JSON.stringify(flags)} />
  <input type="hidden" name="hasPendingAppeal" value={hasPendingAppeal} />
  <TriageDecisionBar
    compact
    buttons={decisionButtons}
    picker={reasonOptions && reasonPicker.open !== null ? picker : undefined}
    fields={reasonOptions ? fields : undefined}
    {problem}
    hint={reasonOptions ? hint : undefined}
  />
</form>

<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
  import type { RulingDraft } from '$lib/components/RulingForm.svelte';
  import InlineReasonFields from '$lib/components/triage/InlineReasonFields.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import {
    decisionEnabled,
    flaggedReasonGroups,
    planDecision,
    planReasonProblem,
    type FlagRef,
    type FlaggedDecision,
  } from '$lib/minor-flags/flagged-decision';
  import { decisionReasonOptions, suggestedReason } from '$lib/triage/decision-reasons';
  import type { Outcome } from '$lib/triage/queue';

  type Verdict = ResolutionVerdict<'heldDetection'> | ResolutionVerdict<'flagReview'>;

  let {
    modelId,
    flags,
    decisions,
    hasPendingAppeal,
    submit,
    actionHref,
    hint,
    draft = $bindable(),
  }: {
    modelId: number;
    flags: FlagRef[];
    /** In key order: 1 and 2 first, then any unkeyed splits. */
    decisions: FlaggedDecision[];
    hasPendingAppeal: boolean;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    /** Under the bar while a reason select shows. */
    hint: string;
    draft: RulingDraft<Verdict>;
  } = $props();

  // Mirrors the main app's refusal: an open appeal blocks keeping a flag, and blocks a re-detection
  // ruling either way. Change with `flaggedDecisionEnabled`.
  const APPEAL_FIRST = "Resolve the owner's open appeal first.";

  const withAppeal = $derived(flags.map((f) => ({ ...f, hasPendingAppeal })));
  const enabled = $derived(decisions.map((d) => decisionEnabled(withAppeal, d)));
  const reasonGroups = $derived(
    flaggedReasonGroups(flags, { keep: decisions[0].label, revert: decisions[1].label })
  );
  const reasonOptions = $derived(reasonGroups ? decisionReasonOptions(reasonGroups) : null);
  // Key 1 takes one press when it has a single specific reason.
  const suggested = $derived(
    enabled[0] && reasonGroups ? suggestedReason(reasonGroups[0].reasons) : ''
  );
  const reason = $derived(draft.reason || suggested);
  let problem = $state<string | null>(null);
  let reasonSelect = $state<HTMLElement | null>(null);

  const outcomeOf = (keep: string[]) =>
    keep.length === flags.length ? 'Flagged' : keep.length === 0 ? 'Not flagged' : 'Split';

  // One step: the decision button submits with the reason and note already in the bar, unless they
  // cannot be recorded for that decision, in which case nothing is sent and the bar says why.
  const decide: SubmitFunction = async (input) => {
    const posted = input.formData.get('keep');
    const index = decisions.findIndex((d) => d.keep.join(',') === posted);
    const refusal =
      index < 0
        ? 'Pick a decision.'
        : !enabled[index]
          ? APPEAL_FIRST
          : planReasonProblem(
              planDecision(flags, decisions[index].keep),
              decisions[index].label,
              reason,
              draft.note
            );
    if (refusal) {
      input.cancel();
      problem = refusal;
      if (refusal !== APPEAL_FIRST) reasonSelect?.focus();
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
  {#each decisions as d, i (d.label)}
    {@const unavailable = !enabled[i] ? APPEAL_FIRST : null}
    {#if d.key}
      <TriageKeyButton
        type="submit"
        key={d.key}
        primary={i === 0}
        name="keep"
        value={d.keep.join(',')}
        formaction={actionHref('decideFlags')}
        disabled={!!unavailable}
        title={unavailable ?? undefined}
      >
        {d.label}
      </TriageKeyButton>
    {:else}
      <Button
        type="submit"
        variant="outline"
        size="sm"
        name="keep"
        value={d.keep.join(',')}
        formaction={actionHref('decideFlags')}
        disabled={!!unavailable}
        title={unavailable ?? undefined}
        class="h-8 border-dark-4 bg-transparent text-[13px] font-semibold text-dark-0 dark:bg-transparent"
      >
        {d.label}
      </Button>
    {/if}
  {/each}
{/snippet}

{#snippet fields()}
  {#if reasonOptions}
    <InlineReasonFields
      options={reasonOptions}
      bind:reason={
        () => reason,
        (next) => {
          draft = { ...draft, reason: next };
          problem = null;
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
    />
  {/if}
{/snippet}

<!-- One form, one button per decision: each button posts the flags it keeps. -->
<form method="POST" action={actionHref('decideFlags')} use:enhance={decide} class="w-full">
  <input type="hidden" name="modelId" value={modelId} />
  <input type="hidden" name="flags" value={JSON.stringify(flags)} />
  <TriageDecisionBar
    buttons={decisionButtons}
    fields={reasonOptions ? fields : undefined}
    {problem}
    hint={reasonOptions ? hint : undefined}
  />
</form>

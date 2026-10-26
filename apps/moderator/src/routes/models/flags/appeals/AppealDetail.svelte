<script module lang="ts">
  import type { ResolutionVerdict, TextScanLabel } from '@civitai/shared/resolution-reasons';
  import { APPEAL_SPLITS } from '$lib/minor-flags/appeal-split';
  import { FLAG_APPEAL_RULING_CHOICES } from '$lib/ruling-choices';

  type Ruling = {
    action: 'upholdAppeal' | 'overturnAppeal' | 'splitAppeal';
    verdict: ResolutionVerdict<'flagAppeal'>;
    label: string;
    outcome: string;
    split?: { lifted: TextScanLabel };
  };

  const choice = (verdict: ResolutionVerdict<'flagAppeal'>) => {
    const found = FLAG_APPEAL_RULING_CHOICES.find((c) => c.verdict === verdict);
    if (!found) throw new Error(`No flag appeal choice for ${verdict}`);
    return found;
  };

  // A split lifts one flag, so it is an Approved ruling. Its button posts only `ruling`; the route
  // action sets minor/poi from it, so a submit before hydration is complete too.
  const RULINGS = {
    Rejected: { ...choice('Rejected'), action: 'upholdAppeal', outcome: 'Appeal rejected' },
    Approved: { ...choice('Approved'), action: 'overturnAppeal', outcome: 'Appeal approved' },
    liftPoi: {
      action: 'splitAppeal',
      verdict: 'Approved',
      label: 'Keep minor, lift real person',
      outcome: 'Kept minor, lifted real person',
      split: APPEAL_SPLITS.liftPoi,
    },
    liftMinor: {
      action: 'splitAppeal',
      verdict: 'Approved',
      label: 'Lift minor, keep real person',
      outcome: 'Lifted minor, kept real person',
      split: APPEAL_SPLITS.liftMinor,
    },
  } satisfies Record<string, Ruling>;

  export type AppealRuling = keyof typeof RULINGS;
  const SPLIT_RULINGS = ['liftPoi', 'liftMinor'] as const satisfies readonly AppealRuling[];
  const rulingOf = (key: AppealRuling): Ruling => RULINGS[key];
</script>

<script lang="ts">
  import { enhance } from '$app/forms';
  import { heldModelFlagTabs } from '../model-flag-tabs';
  import CrossTabChips from '$lib/components/minor-flags/CrossTabChips.svelte';
  import { crossTabChips } from '$lib/minor-flags/cross-tab';
  import type { SubmitFunction } from '@sveltejs/kit';
  import ModelFlagDetailFrame from '$lib/components/minor-flags/ModelFlagDetailFrame.svelte';
  import ReasonPicker from '$lib/components/triage/ReasonPicker.svelte';
  import InlineReasonFields from '$lib/components/triage/InlineReasonFields.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import PriorRulingsCard from '$lib/components/minor-flags/PriorRulingsCard.svelte';
  import SharedFileCard from '$lib/components/minor-flags/SharedFileCard.svelte';
  import { effectiveSource } from '$lib/minor-flags/appeal-filters';
  import type { MinorFlagAppealRow } from '$lib/server/minor-hash.service';
  import { appealDecisionHint, waiting } from '$lib/minor-flags/appeal-row';
  import { flagPromptId } from '$lib/minor-flags/model-detail';
  import { MODEL_FLAGS_APPEALS_PATH } from '$lib/minor-flags/paths';
  import { flagInForce, openVerdicts, poiInForce } from '$lib/minor-flags/text-scan-verdicts';
  import { modelFlagDetail, promptKeyOf } from '$lib/minor-flags/model-detail-request';
  import {
    closeReasonPickerBeyond,
    noteReasonChosen,
    reasonPicker,
    resetReasonPicker,
    submitAwaitingNote,
  } from '$lib/triage/reason-picker.svelte';
  import OwnerSaysCard from '$lib/components/minor-flags/OwnerSaysCard.svelte';
  import WhyFlaggedCard from '$lib/components/minor-flags/WhyFlaggedCard.svelte';
  import type { RulingDraft } from '$lib/components/RulingForm.svelte';
  import { reasonRequiresNote, resolutionReasonsFor } from '@civitai/shared/resolution-reasons';
  import {
    decisionReasonOptions,
    decisionReasonProblem,
    suggestedReason,
  } from '$lib/triage/decision-reasons';
  import AppealTags from './AppealTags.svelte';

  let {
    row,
    civitaiUrl,
    canViewTrainingData,
    verdict,
    error,
    submit,
    actionHref,
    draft = $bindable(),
  }: {
    row: MinorFlagAppealRow;
    civitaiUrl: string;
    canViewTrainingData: boolean;
    /** The outcome already chosen for this appeal, shown in place of the actions. */
    verdict: string | undefined;
    error: string | undefined;
    submit: (verdict: string) => SubmitFunction;
    actionHref: (action: string) => string;
    draft: RulingDraft<AppealRuling>;
  } = $props();

  // A moderator confirming a hash flag keeps `confirmedFrom`, so those appeals show the match too. A
  // real-person snapshot only ever comes from a hash match.
  const hashLabels = $derived([
    ...(row.flagSnapshotLabel === 'minor' &&
    effectiveSource(row.flagSource, row.flagConfirmedFrom) === 'hash'
      ? (['minor'] as const)
      : []),
    ...(row.poiHashFlag ? (['poi'] as const) : []),
  ]);
  const matchedByHash = $derived(hashLabels.length > 0);

  const modelId = $derived(row.modelId);
  const promptKey = $derived(promptKeyOf(openVerdicts(row.textScanFlags).map(({ label, flag }) => flagPromptId(flag.promptIds, label))));
  const detail = $derived(modelFlagDetail(MODEL_FLAGS_APPEALS_PATH, modelId, promptKey));

  // The decision keys, in key order; the labels say what the ruling does to the flag.
  const DECISION_LABEL = {
    Rejected: 'Reject appeal, flag stays',
    Approved: 'Approve appeal, lift flag',
  } as const;

  const poiOpen = $derived(poiInForce(row));
  const decisionHint = $derived(
    appealDecisionHint({
      hash: matchedByHash,
      alsoInAutoFlagged: row.alsoInAutoFlagged,
      textScan: openVerdicts(row.textScanFlags).length > 0,
    })
  );
  const canUphold = $derived(flagInForce(row));

  // Mirrors `resolveMinorFlagAppeal`'s check; change both together.
  const flaggedLabels = $derived.by((): TextScanLabel[] | undefined => {
    const flagged = (['minor', 'poi'] as const).filter((l) => (l === 'minor' ? row.minor : poiOpen));
    return flagged.length ? flagged : undefined;
  });
  const labelsFor = (ruling: Ruling) => (ruling.split ? [ruling.split.lifted] : flaggedLabels);
  // The row can change under the bar (another moderator, a reload).
  const unavailableFor = (key: AppealRuling) =>
    key === 'Rejected' && !canUphold
      ? 'Not flagged any more. Unflag closes the request.'
      : rulingOf(key).split && !(row.minor && poiOpen)
        ? 'Both flags are no longer in force.'
        : null;

  const reasonOptions = $derived(
    decisionReasonOptions(
      FLAG_APPEAL_RULING_CHOICES.map((c) => ({
        label: DECISION_LABEL[c.verdict],
        reasons: resolutionReasonsFor('flagAppeal', c.verdict, flaggedLabels),
      }))
    )
  );
  // Rejecting takes one key when its decision has a single specific reason.
  const suggested = $derived(
    canUphold ? suggestedReason(resolutionReasonsFor('flagAppeal', 'Rejected', flaggedLabels)) : ''
  );
  const reason = $derived(draft.reason || suggested);
  let problem = $state<string | null>(null);
  let reasonSelect = $state<HTMLElement | null>(null);
  let noteInput = $state<HTMLInputElement | null>(null);

  // Key order: the two rulings, then the splits when both flags are in force.
  const decisionKeys = $derived<AppealRuling[]>([
    ...FLAG_APPEAL_RULING_CHOICES.map((c) => c.verdict),
    ...(row.minor && poiOpen ? SPLIT_RULINGS : []),
  ]);
  // The list and its wait for a note belong to this bar; the splits can vanish under an open list.
  $effect(() => () => resetReasonPicker());
  $effect(() => closeReasonPickerBeyond(decisionKeys.length));
  const labelOf = (key: AppealRuling) =>
    key === 'Rejected' || key === 'Approved' ? DECISION_LABEL[key] : RULINGS[key].label;
  const reasonsFor = (key: AppealRuling) => {
    const ruling = rulingOf(key);
    return resolutionReasonsFor('flagAppeal', ruling.verdict, labelsFor(ruling));
  };

  // One step: the ruling button submits with the reason and note already in the bar, unless they
  // cannot be recorded for that ruling, in which case nothing is sent and the bar says why.
  const decide: SubmitFunction = (input) => {
    resetReasonPicker();
    const key = input.formData.get('ruling');
    const ruling = typeof key === 'string' && key in RULINGS ? rulingOf(key as AppealRuling) : null;
    const unavailable = ruling ? unavailableFor(key as AppealRuling) : null;
    const refusal = !ruling
      ? 'Pick a decision.'
      : (unavailable ??
        decisionReasonProblem(
          'flagAppeal',
          ruling.verdict,
          ruling.label,
          reason,
          draft.note,
          labelsFor(ruling)
        ));
    if (!ruling || refusal) {
      input.cancel();
      problem = refusal;
      if (!unavailable) reasonSelect?.focus();
      return;
    }
    problem = null;
    return submit(ruling.outcome)(input);
  };
</script>

{#snippet buttons()}
  {#each decisionKeys as key, i (key)}
    {@const unavailable = unavailableFor(key)}
    <TriageKeyButton
      type="submit"
      key={i + 1}
      primary={i === 0}
      reasons={reasonsFor(key).length > 0}
      name="ruling"
      value={key}
      formaction={actionHref(RULINGS[key].action)}
      disabled={!!unavailable}
      title={unavailable ?? undefined}
    >
      {labelOf(key)}
    </TriageKeyButton>
  {/each}
{/snippet}

{#snippet picker()}
  {@const key = reasonPicker.open === null ? undefined : decisionKeys[reasonPicker.open]}
  {#if key}
    <ReasonPicker
      index={reasonPicker.open!}
      label={labelOf(key)}
      reasons={reasonsFor(key)}
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
    onenter={() => submitAwaitingNote(decisionKeys.length)}
  />
{/snippet}

<ModelFlagDetailFrame
  {row}
  {detail}
  {civitaiUrl}
  {canViewTrainingData}
  {verdict}
  {error}
>
  {#snippet chips()}
    <MetaChip tone="amber" solid>appeal</MetaChip>
    <AppealTags {row} />
    <MetaChip tone="amber">waiting {waiting(row.appealCreatedAt)}</MetaChip>
    <CrossTabChips
      chips={crossTabChips(
        { auto: row.alsoInAutoFlagged, needsReview: row.alsoInNeedsReview },
        row.modelId,
        heldModelFlagTabs()
      )}
      linked
      tone="amber"
    />
  {/snippet}

  {#snippet info()}
    <OwnerSaysCard
      message={row.appealMessage}
      appealedAt={row.appealCreatedAt}
      nthThisYear={row.appealNthThisYear}
    />
    {#each hashLabels as label (label)}
      <SharedFileCard {row} {civitaiUrl} {label} status={{ label: 'under appeal', tone: 'blue' }} />
    {/each}
    <WhyFlaggedCard {row} {canUphold} {detail} />

    <PriorRulingsCard
      title="Prior rulings"
      granted={null}
      grantedByUsername={null}
      rulings={null}
      showPriorClear={false}
      showRulings={false}
      pastAppeals={row.pastAppeals}
      sameFileAppeals={row.sameFileAppeals}
    />

  {/snippet}

  {#snippet decision()}
    <!-- One form, one button per ruling: each button posts its own action. -->
    <form method="POST" action={actionHref('upholdAppeal')} use:enhance={decide} class="w-full">
      <input type="hidden" name="modelId" value={row.modelId} />
      <TriageDecisionBar
        compact
        {buttons}
        picker={reasonPicker.open !== null ? picker : undefined}
        {fields}
        {problem}
        hint={decisionHint}
      />
    </form>
  {/snippet}
</ModelFlagDetailFrame>

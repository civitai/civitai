<script module lang="ts">
  import type { ResolutionVerdict, TextScanLabel } from '@civitai/shared/resolution-reasons';
  import { FLAG_APPEAL_RULING_CHOICES } from '$lib/ruling-choices';

  type Decision = 'uphold' | 'overturn';
  type Ruling = {
    action: 'upholdAppeal' | 'overturnAppeal' | 'splitAppeal';
    verdict: ResolutionVerdict<'flagAppeal'>;
    label: string;
    outcome: string;
    split?: { minor: Decision; poi: Decision; lifted: TextScanLabel };
  };

  const choice = (verdict: ResolutionVerdict<'flagAppeal'>) => {
    const found = FLAG_APPEAL_RULING_CHOICES.find((c) => c.verdict === verdict);
    if (!found) throw new Error(`No flag appeal choice for ${verdict}`);
    return found;
  };

  // A split lifts one flag, so it is an Approved ruling.
  const RULINGS = {
    Rejected: { ...choice('Rejected'), action: 'upholdAppeal', outcome: 'Appeal rejected' },
    Approved: { ...choice('Approved'), action: 'overturnAppeal', outcome: 'Appeal approved' },
    liftPoi: {
      action: 'splitAppeal',
      verdict: 'Approved',
      label: 'Keep minor, lift real person',
      outcome: 'Kept minor, lifted real person',
      split: { minor: 'uphold', poi: 'overturn', lifted: 'poi' },
    },
    liftMinor: {
      action: 'splitAppeal',
      verdict: 'Approved',
      label: 'Lift minor, keep real person',
      outcome: 'Lifted minor, kept real person',
      split: { minor: 'overturn', poi: 'uphold', lifted: 'minor' },
    },
  } satisfies Record<string, Ruling>;

  export type AppealRuling = keyof typeof RULINGS;
  const SPLIT_RULINGS = ['liftPoi', 'liftMinor'] as const satisfies readonly AppealRuling[];
  const rulingOf = (key: AppealRuling): Ruling => RULINGS[key];
</script>

<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import ModelFactsCard from '$lib/components/minor-flags/ModelFactsCard.svelte';
  import UploaderCard from '$lib/components/minor-flags/UploaderCard.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import InlineReasonFields from '$lib/components/triage/InlineReasonFields.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import ModelDetailHeader from '$lib/components/minor-flags/ModelDetailHeader.svelte';
  import PriorRulingsCard from '$lib/components/minor-flags/PriorRulingsCard.svelte';
  import type { MinorFlagAppealRow } from '$lib/server/minor-hash.service';
  import { modelUrl, waiting } from '$lib/minor-flags/appeal-row';
  import { flagInForce, poiInForce } from '$lib/minor-flags/text-scan-verdicts';
  import OwnerSaysCard from '$lib/components/minor-flags/OwnerSaysCard.svelte';
  import PreviewImagesCard from '$lib/components/minor-flags/PreviewImagesCard.svelte';
  import WhyFlaggedCard from '$lib/components/minor-flags/WhyFlaggedCard.svelte';
  import type { RulingDraft } from '$lib/components/RulingForm.svelte';
  import { resolutionReasonsFor } from '@civitai/shared/resolution-reasons';
  import {
    decisionReasonOptions,
    decisionReasonProblem,
    suggestedReason,
  } from '$lib/triage/decision-reasons';
  import AppealTags from './AppealTags.svelte';

  let {
    row,
    civitaiUrl,
    verdict,
    error,
    submit,
    actionHref,
    draft = $bindable(),
  }: {
    row: MinorFlagAppealRow;
    civitaiUrl: string;
    /** The outcome already chosen for this appeal, shown in place of the actions. */
    verdict: string | undefined;
    error: string | undefined;
    submit: (verdict: string) => SubmitFunction;
    actionHref: (action: string) => string;
    draft: RulingDraft<AppealRuling>;
  } = $props();

  const modelHref = $derived(modelUrl(civitaiUrl, row.modelId));

  // The decision keys, in key order; the labels say what the ruling does to the flag.
  const DECISION_LABEL = {
    Rejected: 'Reject appeal, flag stays',
    Approved: 'Approve appeal, lift flag',
  } as const;

  const poiOpen = $derived(poiInForce(row));
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
  let reasonSelect = $state<HTMLSelectElement | null>(null);

  // One step: the ruling button submits with the reason and note already in the bar, unless they
  // cannot be recorded for that ruling, in which case nothing is sent and the bar says why.
  const decide: SubmitFunction = (input) => {
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
    if (ruling.split) {
      input.formData.set('minor', ruling.split.minor);
      input.formData.set('poi', ruling.split.poi);
    }
    return submit(ruling.outcome)(input);
  };
</script>

{#snippet buttons()}
  {#each FLAG_APPEAL_RULING_CHOICES as c, i (c.verdict)}
    {@const unavailable = unavailableFor(c.verdict)}
    <TriageKeyButton
      type="submit"
      key={i + 1}
      primary={i === 0}
      name="ruling"
      value={c.verdict}
      formaction={actionHref(RULINGS[c.verdict].action)}
      disabled={!!unavailable}
      title={unavailable ?? undefined}
    >
      {DECISION_LABEL[c.verdict]}
    </TriageKeyButton>
  {/each}
  {#if row.minor && poiOpen}
    {#each SPLIT_RULINGS as split (split)}
      <Button
        type="submit"
        variant="outline"
        name="ruling"
        value={split}
        formaction={actionHref(RULINGS[split].action)}
        class="h-8 border-dark-4 bg-transparent px-3.5 text-[13px] font-normal text-dark-0 dark:bg-transparent"
      >
        {RULINGS[split].label}
      </Button>
    {/each}
  {/if}
{/snippet}

{#snippet fields()}
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
{/snippet}

<TriageDetailFrame {verdict} {error}>
  {#snippet children()}
    <ModelDetailHeader
      modelId={row.modelId}
      modelName={row.modelName}
      userId={row.userId}
      {civitaiUrl}
    >
      {#snippet chips()}
        <MetaChip tone="amber">appeal</MetaChip>
        <AppealTags {row} />
        <MetaChip tone="amber">waiting {waiting(row.appealCreatedAt)}</MetaChip>
      {/snippet}
    </ModelDetailHeader>

    <PreviewImagesCard images={row.coverImages} allHref={modelHref} />

    <div class="grid gap-4 md:grid-cols-[1fr_minmax(320px,380px)]">
      <OwnerSaysCard message={row.appealMessage} appealedAt={row.appealCreatedAt} />
      <WhyFlaggedCard {row} {civitaiUrl} {canUphold} />
    </div>

    <PriorRulingsCard
      granted={null}
      grantedByUsername={null}
      rulings={null}
      showPriorClear={false}
      showRulings={false}
      pastAppeals={row.pastAppeals}
    />

    <div class="grid gap-4 md:grid-cols-2">
      <ModelFactsCard {row} />
      <UploaderCard {row} />
    </div>
  {/snippet}
  {#snippet actions()}
    <!-- One form, one button per ruling: each button posts its own action. -->
    <form method="POST" action={actionHref('upholdAppeal')} use:enhance={decide} class="w-full">
      <input type="hidden" name="modelId" value={row.modelId} />
      <TriageDecisionBar
        {buttons}
        {fields}
        {problem}
        hint="Every decision here is stored as a labelled example for tuning the text-scan prompts."
      />
    </form>
  {/snippet}
</TriageDetailFrame>

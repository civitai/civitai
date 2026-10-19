<script module lang="ts">
  import type { ResolutionVerdict, TextScanLabel } from '@civitai/shared/resolution-reasons';
  import type { ButtonVariant } from '@civitai/ui/components/ui/button/index.js';
  import { FLAG_APPEAL_RULING_CHOICES } from '$lib/ruling-choices';

  type Decision = 'uphold' | 'overturn';
  type Ruling = {
    action: 'upholdAppeal' | 'overturnAppeal' | 'splitAppeal';
    verdict: ResolutionVerdict<'flagAppeal'>;
    label: string;
    confirmLabel: string;
    variant: ButtonVariant;
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
      confirmLabel: 'Confirm keep minor, lift real person',
      variant: 'default',
      outcome: 'Kept minor, lifted real person',
      split: { minor: 'uphold', poi: 'overturn', lifted: 'poi' },
    },
    liftMinor: {
      action: 'splitAppeal',
      verdict: 'Approved',
      label: 'Lift minor, keep real person',
      confirmLabel: 'Confirm lift minor, keep real person',
      variant: 'default',
      outcome: 'Lifted minor, kept real person',
      split: { minor: 'overturn', poi: 'uphold', lifted: 'minor' },
    },
  } satisfies Record<string, Ruling>;

  export type AppealRuling = keyof typeof RULINGS;
  const SPLIT_RULINGS = ['liftPoi', 'liftMinor'] as const satisfies readonly AppealRuling[];
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
  import { resolutionReasonError } from '@civitai/shared/resolution-reasons';
  import AppealTags from './AppealTags.svelte';

  let {
    row,
    civitaiUrl,
    verdict,
    error,
    submit,
    actionHref,
    choose,
    draft = $bindable(),
  }: {
    row: MinorFlagAppealRow;
    civitaiUrl: string;
    /** The outcome already chosen for this appeal, shown in place of the actions. */
    verdict: string | undefined;
    error: string | undefined;
    submit: (verdict: string) => SubmitFunction;
    actionHref: (action: string) => string;
    choose: (ruling: AppealRuling) => void;
    draft: RulingDraft<AppealRuling>;
  } = $props();

  const modelHref = $derived(modelUrl(civitaiUrl, row.modelId));

  // The decision keys, in key order; the labels say what the ruling does to the flag.
  const DECISION_LABEL = {
    Rejected: 'Reject appeal, flag stays',
    Approved: 'Approve appeal, lift flag',
  } as const;
  const FIELDS_GRID = 'grid gap-2 sm:grid-cols-[minmax(14rem,22rem)_1fr_auto]';

  const poiOpen = $derived(poiInForce(row));
  const canUphold = $derived(flagInForce(row));

  const ruling = $derived<Ruling | null>(draft.verdict ? RULINGS[draft.verdict] : null);
  // Mirrors `resolveMinorFlagAppeal`'s check; change both together.
  const ruledOn = $derived.by((): TextScanLabel[] | undefined => {
    if (ruling?.split) return [ruling.split.lifted];
    const flagged = (['minor', 'poi'] as const).filter((l) => (l === 'minor' ? row.minor : poiOpen));
    return flagged.length ? flagged : undefined;
  });
  // The row can change under a chosen ruling (another moderator, a reload).
  const unavailable = $derived(
    (draft.verdict === 'Rejected' && !canUphold) || (!!ruling?.split && !(row.minor && poiOpen))
  );
  const unrecordable = $derived(
    ruling
      ? resolutionReasonError('flagAppeal', ruling.verdict, draft.reason, draft.note, ruledOn)
      : null
  );
</script>

{#snippet buttons()}
  {#each FLAG_APPEAL_RULING_CHOICES as c, i (c.verdict)}
    {@const blocked = c.verdict === 'Rejected' && !canUphold}
    <TriageKeyButton
      key={i + 1}
      primary={i === 0}
      pressed={draft.verdict === c.verdict}
      disabled={blocked}
      title={blocked ? 'Not flagged any more. Unflag closes the request.' : undefined}
      onclick={() => choose(c.verdict)}
    >
      {DECISION_LABEL[c.verdict]}
    </TriageKeyButton>
  {/each}
  {#if row.minor && poiOpen}
    {#each SPLIT_RULINGS as split (split)}
      <Button
        size="lg"
        variant="outline"
        class="h-11 text-base {draft.verdict === split ? 'ring-2 ring-white/50' : ''}"
        aria-pressed={draft.verdict === split}
        onclick={() => choose(split)}
      >
        {RULINGS[split].label}
      </Button>
    {/each}
  {/if}
{/snippet}

{#snippet fields()}
  {#if ruling}
    <!-- Keyed: `use:enhance` reads its handler once, and each ruling reports its own outcome. -->
    {#key draft.verdict}
      <form
        method="POST"
        action={actionHref(ruling.action)}
        use:enhance={submit(ruling.outcome)}
        class={FIELDS_GRID}
      >
        <input type="hidden" name="modelId" value={row.modelId} />
        {#if ruling.split}
          <input type="hidden" name="minor" value={ruling.split.minor} />
          <input type="hidden" name="poi" value={ruling.split.poi} />
        {/if}
        <InlineReasonFields
          subject="flagAppeal"
          verdict={ruling.verdict}
          labels={ruledOn}
          bind:reason={() => draft.reason, (reason) => (draft = { ...draft, reason })}
          bind:note={() => draft.note, (note) => (draft = { ...draft, note })}
        />
        <Button
          type="submit"
          size="lg"
          variant={ruling.variant}
          class="h-10"
          disabled={unavailable || !!unrecordable}
        >
          {ruling.confirmLabel}
        </Button>
      </form>
    {/key}
  {:else}
    <div class={FIELDS_GRID}>
      <InlineReasonFields subject="flagAppeal" verdict={null} />
    </div>
  {/if}
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
    <TriageDecisionBar
      {buttons}
      {fields}
      hint="Every decision here is stored as a labelled example for tuning the text-scan prompts."
    />
  {/snippet}
</TriageDetailFrame>

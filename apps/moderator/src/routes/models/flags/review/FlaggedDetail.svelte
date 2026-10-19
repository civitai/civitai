<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import FlaggedSourceBadge from '$lib/components/minor-flags/FlaggedSourceBadge.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import ModelDetailHeader from '$lib/components/minor-flags/ModelDetailHeader.svelte';
  import ModelFactsCard from '$lib/components/minor-flags/ModelFactsCard.svelte';
  import PreviewImagesCard from '$lib/components/minor-flags/PreviewImagesCard.svelte';
  import PriorRulingsCard from '$lib/components/minor-flags/PriorRulingsCard.svelte';
  import ScannedNamesCard from '$lib/components/minor-flags/ScannedNamesCard.svelte';
  import ScannedTextCard from '$lib/components/minor-flags/ScannedTextCard.svelte';
  import SharedFileCard from '$lib/components/minor-flags/SharedFileCard.svelte';
  import UploaderCard from '$lib/components/minor-flags/UploaderCard.svelte';
  import { chooseVerdict, type RulingDraft } from '$lib/components/RulingForm.svelte';
  import InlineReasonFields from '$lib/components/triage/InlineReasonFields.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { ago, modelUrl } from '$lib/minor-flags/appeal-row';
  import { flaggedDecisionEnabled } from '$lib/minor-flags/flagged-decision';
  import { MODEL_FLAGS_APPEALS_PATH } from '$lib/minor-flags/paths';
  import {
    detectionCopy,
    detectionKind,
    detectionSections,
    latestScanDisagrees,
    scanVerdictProvenance,
    scanVerdictText,
  } from '$lib/minor-flags/text-scan-verdicts';
  import { FLAG_REVIEW_RULING_CHOICES, HELD_DETECTION_RULING_CHOICES } from '$lib/ruling-choices';
  import { resolutionReasonError } from '@civitai/shared/resolution-reasons';
  import type { FlaggedRow } from '$lib/server/minor-hash.service';
  import type { Outcome } from '$lib/triage/queue';
  import type { RulingChoice } from '$lib/ruling-choices';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';

  type Verdict = ResolutionVerdict<'heldDetection'> | ResolutionVerdict<'flagReview'>;

  let {
    row,
    civitaiUrl,
    verdict,
    error,
    submit,
    actionHref,
    draft = $bindable(),
  }: {
    row: FlaggedRow;
    civitaiUrl: string;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    draft: RulingDraft<Verdict>;
  } = $props();

  // Mirrors the main app's refusal: an open appeal blocks keeping a flag, and blocks a re-detection
  // ruling either way. Lifting a hash or text-scan row is allowed. Change with `flaggedDecisionEnabled`.
  const APPEAL_FIRST = "Resolve the owner's open appeal first.";
  const blocked = $derived(row.hasPendingAppeal);
  const enabled = $derived(flaggedDecisionEnabled(row));
  const canOpenAppeals = $derived(
    page.data.modelFlagTabs?.some((tab: { href: string }) => tab.href === MODEL_FLAGS_APPEALS_PATH)
  );
  const appealsHref = $derived(`${MODEL_FLAGS_APPEALS_PATH}?q=${row.modelId}`);

  const redetection = $derived(row.source === 'redetected' ? row.redetected : null);
  const copy = $derived(redetection ? detectionCopy(detectionKind(redetection)) : null);
  const sections = $derived(
    redetection ? detectionSections(detectionKind(redetection), row.rulings) : null
  );
  const flagged = $derived(row.label === 'poi' ? row.poi : row.minor);

  const DECISIONS = [
    { action: 'keepFlag', label: 'Keep flag', outcome: 'Flag kept' },
    { action: 'liftFlag', label: 'Lift flag', outcome: 'Flag lifted' },
  ] as const;
  // Re-detections and text-scan flags rule with an inline reason; hash flags submit straight away.
  const reasoned = $derived(row.source !== 'hash');
  const choices: readonly RulingChoice<Verdict>[] = $derived(
    row.source === 'text-scan' ? FLAG_REVIEW_RULING_CHOICES : HELD_DETECTION_RULING_CHOICES
  );
  const decisionFor = (verdict: Verdict) =>
    verdict === 'Kept'
      ? ({ action: 'keepFlag', label: 'Keep flag' } as const)
      : ({ action: 'liftFlag', label: 'Lift flag' } as const);
  const reasonError = (verdict: Verdict) =>
    row.source === 'text-scan'
      ? resolutionReasonError(
          'flagReview',
          verdict as ResolutionVerdict<'flagReview'>,
          draft.reason,
          draft.note,
          [row.label]
        )
      : resolutionReasonError(
          'heldDetection',
          verdict as ResolutionVerdict<'heldDetection'>,
          draft.reason,
          draft.note,
          [row.label]
        );
  const scanEntry = $derived(row.scanEntry);
  const latest = $derived(row.latestScan?.[row.label] ?? null);
  const labelName = $derived(row.label === 'poi' ? 'real person' : 'minor');
  const FIELDS_GRID = 'grid gap-2 sm:grid-cols-[minmax(14rem,22rem)_1fr_auto]';

  const chosen = $derived(choices.find((c) => c.verdict === draft.verdict));
  const unrecordable = $derived(
    chosen
      ? (!enabled[chosen.verdict === 'Kept' ? 0 : 1] ? APPEAL_FIRST : reasonError(chosen.verdict))
      : null
  );
  const choose = (verdict: Verdict) => (draft = chooseVerdict(draft, verdict));
</script>

{#snippet appealNotice()}
  <div class="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-200">
    The owner has an open appeal on this model. Lifting the flag here closes it with the same reason;
    keeping the flag has to wait for the appeal.
    {#if canOpenAppeals}
      <a href={appealsHref} class={LINK_CLASS}>Open it in Appeals</a>.
    {:else}
      It is waiting in Appeals.
    {/if}
  </div>
{/snippet}

{#snippet verdictFields()}
  <input type="hidden" name="modelId" value={row.modelId} />
  <input type="hidden" name="label" value={row.label} />
  <input type="hidden" name="source" value={row.source} />
  {#if row.textHash}<input type="hidden" name="textHash" value={row.textHash} />{/if}
{/snippet}

{#snippet buttons()}
  {#if reasoned}
    {#each choices as c, i (c.verdict)}
      {@const unavailable = !enabled[i] ? APPEAL_FIRST : null}
      <TriageKeyButton
        key={i + 1}
        primary={i === 0}
        pressed={draft.verdict === c.verdict}
        disabled={!!unavailable}
        title={unavailable ?? undefined}
        onclick={() => choose(c.verdict)}
      >
        {decisionFor(c.verdict).label}
      </TriageKeyButton>
    {/each}
  {:else}
    {#each DECISIONS as choice, i (choice.action)}
      {@const unavailable = !enabled[i] ? APPEAL_FIRST : null}
      <form
        method="POST"
        action={actionHref(choice.action)}
        data-triage-action={choice.action}
        use:enhance={submit(choice.outcome)}
      >
        {@render verdictFields()}
        <TriageKeyButton
          type="submit"
          key={i + 1}
          primary={i === 0}
          disabled={!!unavailable}
          title={unavailable ?? undefined}
        >
          {choice.label}
        </TriageKeyButton>
      </form>
    {/each}
  {/if}
{/snippet}

{#snippet fields()}
  {#if chosen}
    <form
      method="POST"
      action={actionHref(decisionFor(chosen.verdict).action)}
      use:enhance={submit((form) => (form.get('status') === 'Kept' ? 'Flagged' : 'Not flagged'))}
      class={FIELDS_GRID}
    >
      {@render verdictFields()}
      <input type="hidden" name="status" value={chosen.verdict} />
      {#if row.source === 'text-scan'}
        <InlineReasonFields
          subject="flagReview"
          verdict={chosen.verdict as ResolutionVerdict<'flagReview'>}
          labels={[row.label]}
          bind:reason={() => draft.reason, (reason) => (draft = { ...draft, reason })}
          bind:note={() => draft.note, (note) => (draft = { ...draft, note })}
        />
      {:else}
        <InlineReasonFields
          subject="heldDetection"
          verdict={chosen.verdict as ResolutionVerdict<'heldDetection'>}
          labels={[row.label]}
          bind:reason={() => draft.reason, (reason) => (draft = { ...draft, reason })}
          bind:note={() => draft.note, (note) => (draft = { ...draft, note })}
        />
      {/if}
      <Button
        type="submit"
        size="lg"
        variant={chosen.variant}
        class="h-10"
        disabled={!!unrecordable}
      >
        {chosen.confirmLabel}
      </Button>
    </form>
  {:else}
    <div class={FIELDS_GRID}>
      <InlineReasonFields subject={row.source === 'text-scan' ? 'flagReview' : 'heldDetection'} verdict={null} />
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
        <FlaggedSourceBadge {row} />
        <FlagBadge label={row.label} />
        {#if row.hasPendingAppeal}<MetaChip tone="amber">also in Appeals</MetaChip>{/if}
        {#if row.daysLeft !== null}
          <MetaChip tone="amber"
            >{row.daysLeft === 0 ? 'review window closed' : `${row.daysLeft} d left in review window`}</MetaChip
          >
        {/if}
      {/snippet}
    </ModelDetailHeader>

    <PreviewImagesCard images={row.coverImages} allHref={modelUrl(civitaiUrl, row.modelId)} />

    {#if redetection && copy && sections}
      <div
        class={redetection.names?.length ? 'grid gap-4 md:grid-cols-[1fr_minmax(320px,380px)]' : ''}
      >
        <ScannedTextCard
          title="Why it was held"
          label={row.label}
          detection={redetection}
          {flagged}
          explanation={copy.explanation}
        />
        {#if redetection.names?.length}
          <ScannedNamesCard names={redetection.names} />
        {/if}
      </div>
      {#if blocked}{@render appealNotice()}{/if}
      <PriorRulingsCard
        granted={row.granted}
        grantedByUsername={row.grantedByUsername}
        rulings={row.rulings}
        showPriorClear={sections.priorClear}
        showRulings={sections.rulings}
        pastAppeals={row.pastAppeals}
      />
    {:else if row.source === 'text-scan'}
      <div
        class={scanEntry?.names?.length ? 'grid gap-4 md:grid-cols-[1fr_minmax(320px,380px)]' : ''}
      >
        <TriageCard dense title="Why it was flagged">
          <div class="space-y-2 text-dark-0">
            <p class="m-0">
              Text scan: {labelName}
              {#if row.flaggedAt}
                <span class="text-sm text-dark-2" title={dateTime(row.flaggedAt)}>
                  · flagged {ago(row.flaggedAt)}
                </span>
              {/if}
            </p>
            <p class="m-0 text-sm">{scanEntry?.reason ?? 'No reason recorded.'}</p>
            <p class="m-0 text-sm text-dark-2">
              The scan flagged this automatically; no moderator has ruled on it.
            </p>
            {#if latest}
              {@const provenance = scanVerdictProvenance(latest)}
              <div class="rounded-md bg-dark-6 p-3 text-sm">
                <p class="m-0 font-medium text-white">Latest scan</p>
                <p class="m-0 mt-1">{scanVerdictText(latest)}</p>
                <p class="m-0 text-dark-2">
                  {provenance.source} ·
                  {#if provenance.note}
                    <span title={dateTime(latest.updatedAt)}>{provenance.note}</span>
                  {:else}
                    <span title={dateTime(latest.updatedAt)}>{ago(latest.updatedAt)}</span>
                  {/if}
                </p>
                {#if latestScanDisagrees(row.latestScan, row.label)}
                  <p
                    class="m-0 mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200"
                  >
                    Latest scan: not detected. Keeping the flag is still your call.
                  </p>
                {/if}
              </div>
            {/if}
            {#if blocked}{@render appealNotice()}{/if}
          </div>
        </TriageCard>
        {#if scanEntry?.names?.length}
          <ScannedNamesCard names={scanEntry.names} />
        {/if}
      </div>
      <PriorRulingsCard
        granted={null}
        grantedByUsername={null}
        rulings={row.rulings}
        showPriorClear={false}
        showRulings={(row.rulings?.length ?? 0) > 0}
        pastAppeals={row.pastAppeals}
      />
    {:else}
      <div class="grid gap-4 lg:grid-cols-2">
        <TriageCard dense title="Why it was flagged">
          <div class="space-y-2 text-dark-0">
            <p class="m-0">
              Its main file is byte-identical to a file in a model a moderator flagged as minor. The
              flag was applied automatically.
            </p>
            {#if row.flaggedAt}
              <p class="m-0 text-sm text-dark-2" title={dateTime(row.flaggedAt)}>
                hash sweep, {ago(row.flaggedAt)}{#if row.daysLeft !== null}
                  · {#if row.daysLeft === 0}review window closed; the flag is presumed correct{:else}{row.daysLeft}
                    day{row.daysLeft === 1 ? '' : 's'} left; after that the flag is presumed
                    correct{/if}{/if}
              </p>
            {/if}
            {#if row.prevNsfw != null || row.prevGalleryLevel != null}
              <p class="m-0 text-sm text-dark-2">
                Before the flag: NSFW {row.prevNsfw ? 'on' : 'off'}{row.prevGalleryLevel != null
                  ? `, gallery level ${row.prevGalleryLevel}`
                  : ''}
              </p>
            {/if}
            {#if blocked}{@render appealNotice()}{/if}
          </div>
        </TriageCard>
        <SharedFileCard {row} {civitaiUrl} />
      </div>
      <PriorRulingsCard
        granted={null}
        grantedByUsername={null}
        rulings={row.rulings}
        showPriorClear={false}
        showRulings
        pastAppeals={row.pastAppeals}
      />
    {/if}

    <div class="grid gap-4 md:grid-cols-2">
      <ModelFactsCard {row} />
      <UploaderCard {row} />
    </div>
  {/snippet}
  {#snippet actions()}
    {#if reasoned}
      <TriageDecisionBar
        {buttons}
        {fields}
        hint="Every decision here is stored as a labelled example for tuning the text-scan prompts."
      />
    {:else}
      <!-- No reason form: the main app's confirm and revert endpoints record none yet. -->
      <TriageDecisionBar {buttons} />
    {/if}
  {/snippet}
</TriageDetailFrame>

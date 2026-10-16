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
  } from '$lib/minor-flags/text-scan-verdicts';
  import { HELD_DETECTION_RULING_CHOICES } from '$lib/ruling-choices';
  import { resolutionReasonError } from '@civitai/shared/resolution-reasons';
  import type { FlaggedRow } from '$lib/server/minor-hash.service';
  import type { Outcome } from '$lib/triage/queue';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';

  type Verdict = ResolutionVerdict<'heldDetection'>;

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
  // ruling either way. Lifting a hash row is allowed. Change with `flaggedDecisionEnabled`.
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
  const HELD_DECISIONS = {
    Kept: { action: 'keepFlag', label: 'Keep flag' },
    Dismissed: { action: 'liftFlag', label: 'Lift flag' },
  } as const;
  const FIELDS_GRID = 'grid gap-2 sm:grid-cols-[minmax(14rem,22rem)_1fr_auto]';

  const chosen = $derived(HELD_DETECTION_RULING_CHOICES.find((c) => c.verdict === draft.verdict));
  const unrecordable = $derived(
    chosen
      ? (!enabled[chosen.verdict === 'Kept' ? 0 : 1]
          ? APPEAL_FIRST
          : resolutionReasonError('heldDetection', chosen.verdict, draft.reason, draft.note, [
              row.label,
            ]))
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
  {#if row.source === 'redetected'}
    {#each HELD_DETECTION_RULING_CHOICES as c, i (c.verdict)}
      {@const unavailable = !enabled[i] ? APPEAL_FIRST : null}
      <TriageKeyButton
        key={i + 1}
        primary={i === 0}
        pressed={draft.verdict === c.verdict}
        disabled={!!unavailable}
        title={unavailable ?? undefined}
        onclick={() => choose(c.verdict)}
      >
        {HELD_DECISIONS[c.verdict].label}
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
      action={actionHref(HELD_DECISIONS[chosen.verdict].action)}
      use:enhance={submit((form) => (form.get('status') === 'Kept' ? 'Flagged' : 'Not flagged'))}
      class={FIELDS_GRID}
    >
      {@render verdictFields()}
      <input type="hidden" name="status" value={chosen.verdict} />
      <InlineReasonFields
        subject="heldDetection"
        verdict={chosen.verdict}
        labels={[row.label]}
        bind:reason={() => draft.reason, (reason) => (draft = { ...draft, reason })}
        bind:note={() => draft.note, (note) => (draft = { ...draft, note })}
      />
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
      <InlineReasonFields subject="heldDetection" verdict={null} />
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
        <FlaggedSourceBadge {row} size="md" />
        <FlagBadge label={row.label} size="md" />
        {#if row.hasPendingAppeal}<MetaChip size="md" tone="amber">also in Appeals</MetaChip>{/if}
        {#if row.daysLeft !== null}
          <MetaChip size="md" tone="amber"
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
    {:else}
      <div class="grid gap-4 lg:grid-cols-2">
        <TriageCard title="Why it was flagged">
          <div class="space-y-2 text-base text-dark-0">
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
    {#if row.source === 'redetected'}
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

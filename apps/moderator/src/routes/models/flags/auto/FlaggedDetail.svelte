<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { IconMessage } from '@tabler/icons-svelte';
  import { heldModelFlagTabs } from '../model-flag-tabs';
  import CrossTabChips from '$lib/components/minor-flags/CrossTabChips.svelte';
  import EnforcementChip from '$lib/components/minor-flags/EnforcementChip.svelte';
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import FlagDecisionForm from '$lib/components/minor-flags/FlagDecisionForm.svelte';
  import FlagVerdictBlock from '$lib/components/minor-flags/FlagVerdictBlock.svelte';
  import FlaggedSourceBadge from '$lib/components/minor-flags/FlaggedSourceBadge.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import PriorRulingsCard from '$lib/components/minor-flags/PriorRulingsCard.svelte';
  import ScanProvenance from '$lib/components/minor-flags/ScanProvenance.svelte';
  import ScannedNamesCard from '$lib/components/minor-flags/ScannedNamesCard.svelte';
  import SharedFileCard from '$lib/components/minor-flags/SharedFileCard.svelte';
  import ModelFlagDetailFrame from '$lib/components/minor-flags/ModelFlagDetailFrame.svelte';
  import type { RulingDraft } from '$lib/components/RulingForm.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { ago } from '$lib/minor-flags/appeal-row';
  import { crossTabChips } from '$lib/minor-flags/cross-tab';
  import {
    FLAG_LABEL_NAMES,
    flaggedDecisions,
    type FlagRef,
  } from '$lib/minor-flags/flagged-decision';
  import {
    HASH_FLAG_REASON,
    flagPromptId,
    hashSweepText,
    flagScanSource,
    textSinceFlag,
  } from '$lib/minor-flags/model-detail';
  import { MODEL_FLAGS_APPEALS_PATH, MODEL_FLAGS_AUTO_PATH } from '$lib/minor-flags/paths';
  import { modelFlagDetail, promptKeyOf } from '$lib/minor-flags/model-detail-request';
  import { latestScanDisagrees, scanVerdictProvenance } from '$lib/minor-flags/text-scan-verdicts';
  import type { FlaggedFlagItem, FlaggedRow } from '$lib/server/minor-hash.service';
  import type { Outcome } from '$lib/triage/queue';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';

  type Verdict = ResolutionVerdict<'heldDetection'> | ResolutionVerdict<'flagReview'>;

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
    row: FlaggedRow;
    civitaiUrl: string;
    canViewTrainingData: boolean;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    draft: RulingDraft<Verdict>;
  } = $props();

  const heldTabs = $derived(
    heldModelFlagTabs()
  );
  const canOpenAppeals = $derived(heldTabs.includes(MODEL_FLAGS_APPEALS_PATH));
  const appealsHref = $derived(`${MODEL_FLAGS_APPEALS_PATH}?q=${row.modelId}`);
  const alsoIn = $derived(
    crossTabChips(
      { appeals: row.hasPendingAppeal, needsReview: row.alsoInNeedsReview },
      row.modelId,
      heldTabs
    )
  );

  const flags = $derived(row.flags);
  const flagRefs: FlagRef[] = $derived(
    flags.map(({ label, source, textHash }) => ({ label, source, textHash }))
  );
  const textScans = $derived(flags.filter((f) => f.source === 'text-scan'));
  const hashFlag = $derived(flags.find((f) => f.source === 'hash') ?? null);
  const sources = $derived([...new Map(flags.map((f) => [f.source, f])).values()]);
  const labels = $derived([...new Set(flags.map((f) => f.label))]);

  const modelId = $derived(row.modelId);
  const promptIdOf = (flag: FlaggedFlagItem) => flagPromptId(flag.scanEntry?.promptIds, flag.label);
  const promptKey = $derived(promptKeyOf(flags.map(promptIdOf)));
  const detail = $derived(modelFlagDetail(MODEL_FLAGS_AUTO_PATH, modelId, promptKey));
  // One scanned-text card per row: the scan writes every label it flags from one text.
  const scanned = $derived(textScans.find((f) => f.textHash) ?? null);
  const names = $derived([...new Set(textScans.flatMap((f) => f.scanEntry?.names ?? []))]);
  const since = $derived(textSinceFlag(scanned?.textHash, row.scanRows));
  const decisions = $derived(flaggedDecisions(flagRefs));
</script>

{#snippet appealNotice()}
  <div
    class="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 text-xs leading-[1.45] text-amber-200"
  >
    <IconMessage class="mt-px size-3.5 shrink-0" aria-hidden="true" />
    <p class="m-0">
      The owner has an open appeal on this model. Deciding here resolves it: keeping every flag
      rejects the appeal, reverting every flag approves it, and a split rules each label. The reason
      is recorded on the appeal.
      {#if canOpenAppeals}
        <a href={appealsHref} class={LINK_CLASS}>Open it in Appeals</a>.
      {:else}
        It is waiting in Appeals.
      {/if}
    </p>
  </div>
{/snippet}

{#snippet textScanWhy(flag: FlaggedFlagItem)}
  {@const entry = flag.scanEntry}
  {@const latest = row.latestScan?.[flag.label] ?? null}
  <FlagVerdictBlock label={flag.label} reason={entry?.reason}>
    {#snippet provenance()}
      <ScanProvenance
        at={entry?.at ?? flag.flaggedAt}
        source={flagScanSource(entry?.workflowId, row.scanRows)}
        promptId={promptIdOf(flag)}
        {detail}
      />
    {/snippet}
    {#if latest && latestScanDisagrees(row.latestScan, flag.label)}
      {@const later = scanVerdictProvenance(latest)}
      <p
        class="m-0 mt-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-200"
        title={dateTime(latest.updatedAt)}
      >
        The latest {later.source} ({later.note ?? ago(latest.updatedAt)}) says not detected.
        Keeping the flag is still your call.
      </p>
    {/if}
  </FlagVerdictBlock>
{/snippet}

{#snippet hashWhy(flag: FlaggedFlagItem)}
  <FlagVerdictBlock label={flag.label} reason={HASH_FLAG_REASON}>
    {#snippet provenance()}
      <span title={flag.flaggedAt ? dateTime(flag.flaggedAt) : undefined}
        >{hashSweepText(flag.flaggedAt, flag.daysLeft)}</span
      >
    {/snippet}
  </FlagVerdictBlock>
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
    <EnforcementChip applied />
    {#each sources as flag (flag.source)}<FlaggedSourceBadge row={flag} />{/each}
    {#each labels as label (label)}<FlagBadge {label} />{/each}
    <CrossTabChips chips={alsoIn} linked tone="amber" />
    {#if hashFlag?.daysLeft != null}
      <MetaChip tone="amber"
        >{hashFlag.daysLeft === 0
          ? 'review window closed'
          : `${hashFlag.daysLeft} d left in review window`}</MetaChip
      >
    {/if}
  {/snippet}

  {#snippet info()}
    {#if hashFlag}
      <SharedFileCard {row} {civitaiUrl} status={{ label: 'under review', tone: 'blue' }} />
    {/if}
    {#if textScans.length || hashFlag}
      <TriageCard dense title="Why it was flagged">
        <div class="space-y-3">
          {#each flags as flag (`${flag.label}:${flag.source}`)}
            {#if flag.source === 'text-scan'}
              {@render textScanWhy(flag)}
            {:else if flag.source === 'hash'}
              {@render hashWhy(flag)}
            {/if}
          {/each}
          {#if row.hasPendingAppeal}{@render appealNotice()}{/if}
        </div>
      </TriageCard>
      {#if names.length || scanned?.textHash}
        <ScannedNamesCard {names} textHash={scanned?.textHash} {since} />
      {/if}
    {:else if row.hasPendingAppeal}
      {@render appealNotice()}
    {/if}

    <!-- One history card per label: a ruling stub records no label of its own. -->
    {#each labels as label, i (label)}
      {@const flag = flags.find((f) => f.label === label)!}
      <PriorRulingsCard
        title={labels.length > 1
          ? `Prior rulings and appeals: ${FLAG_LABEL_NAMES[label]}`
          : undefined}
        granted={null}
        grantedByUsername={null}
        rulings={flag.rulings}
        showPriorClear={false}
        showRulings
        pastAppeals={i === 0 ? row.pastAppeals : undefined}
        sameFileAppeals={i === 0 ? row.sameFileAppeals : undefined}
        appealOpen={i === 0 ? row.hasPendingAppeal : undefined}
      />
    {/each}

  {/snippet}

  {#snippet decision()}
    <FlagDecisionForm
      modelId={row.modelId}
      flags={flagRefs}
      {decisions}
      hasPendingAppeal={row.hasPendingAppeal}
      canRuleAppeals={canOpenAppeals}
      {submit}
      {actionHref}
      hint={row.hasPendingAppeal
        ? "This decision resolves the owner's appeal; the reason is recorded on it."
        : 'Every decision here is stored as a labelled example for tuning the text-scan prompts.'}
      bind:draft
    />
  {/snippet}
</ModelFlagDetailFrame>

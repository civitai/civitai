<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { heldModelFlagTabs } from '../model-flag-tabs';
  import { IconMessage } from '@tabler/icons-svelte';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
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
  import type { RulingDraft } from '$lib/components/RulingForm.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import ModelFlagDetailFrame from '$lib/components/minor-flags/ModelFlagDetailFrame.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { ago } from '$lib/minor-flags/appeal-row';
  import { crossTabChips } from '$lib/minor-flags/cross-tab';
  import { FLAG_LABEL_NAMES, needsReviewDecisions } from '$lib/minor-flags/flagged-decision';
  import {
    flagPromptId,
    flagScanSource,
    textSinceFlag,
  } from '$lib/minor-flags/model-detail';
  import { leadRefs } from '$lib/minor-flags/needs-review';
  import { MODEL_FLAGS_APPEALS_PATH, MODEL_FLAGS_NEEDS_REVIEW_PATH } from '$lib/minor-flags/paths';
  import { modelFlagDetail, promptKeyOf } from '$lib/minor-flags/model-detail-request';
  import {
    detectionCopy,
    detectionKind,
    detectionSections,
  } from '$lib/minor-flags/text-scan-verdicts';
  import type { NeedsReviewRow } from '$lib/server/minor-hash.service';
  import type { Outcome } from '$lib/triage/queue';

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
    row: NeedsReviewRow;
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
  const alsoIn = $derived(
    crossTabChips(
      { appeals: row.hasPendingAppeal, auto: row.alsoInAutoFlagged },
      row.modelId,
      heldTabs
    )
  );

  const detections = $derived(row.flags.filter((f) => f.redetected));
  const match = $derived(row.match);
  const poiMatch = $derived(row.poiMatch);
  const leads = $derived(leadRefs(row));
  const labels = $derived([...new Set(leads.map((f) => f.label))]);
  const decisions = $derived(needsReviewDecisions(leads));
  const scanned = $derived(detections.find((f) => f.redetected?.textHash)?.redetected ?? null);
  const names = $derived([...new Set(detections.flatMap((f) => f.redetected?.names ?? []))]);

  const modelId = $derived(row.modelId);
  const promptKey = $derived(promptKeyOf(detections.map((f) => flagPromptId(f.redetected?.promptIds, f.label))));
  const detail = $derived(modelFlagDetail(MODEL_FLAGS_NEEDS_REVIEW_PATH, modelId, promptKey));
</script>

<ModelFlagDetailFrame
  {row}
  {detail}
  {civitaiUrl}
  {canViewTrainingData}
  {verdict}
  {error}
>
  {#snippet chips()}
    <EnforcementChip applied={false} />
    {#each detections as flag (flag.label)}<FlaggedSourceBadge row={flag} />{/each}
    {#if match || poiMatch}<MetaChip tone="blue">hash</MetaChip>{/if}
    {#each labels as label (label)}<FlagBadge {label} />{/each}
    {#if match}<MetaChip tone="amber">different uploader</MetaChip>{/if}
    <CrossTabChips chips={alsoIn} linked tone="amber" />
  {/snippet}

  {#snippet info()}
    {#if row.hasPendingAppeal && detections.length}
      <div
        class="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 text-xs leading-[1.45] text-amber-200"
      >
        <IconMessage class="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <p class="m-0">
          The owner has an open appeal on this model, and a held detection can't be ruled until it
          is settled.
          {#if heldTabs.includes(MODEL_FLAGS_APPEALS_PATH)}
            <a href="{MODEL_FLAGS_APPEALS_PATH}?q={row.modelId}" class={LINK_CLASS}
              >Open it in Appeals</a
            >.
          {:else}
            It is waiting in Appeals.
          {/if}
        </p>
      </div>
    {/if}

    {#if match}
      <SharedFileCard
        row={{
          ...match,
          modelId: row.modelId,
          modelName: row.modelName,
          userId: row.userId,
          username: row.username,
        }}
        {civitaiUrl}
        status={{ label: 'not flagged', tone: 'green' }}
      />
      <TriageCard dense title="Why nothing was applied">
        <div class="space-y-2 text-dark-0">
          <p class="m-0">
            The uploader is a different account, so the flag was not copied over automatically.
            Decide whether this upload is the same content under a new name.
          </p>
          <!-- No match timestamp is stored, so the shared file's upload stands in for when the
               sweep could first have seen it. -->
          <p class="m-0 text-[11px] text-dark-2" title={dateTime(match.uploadedAt)}>
            hash sweep · file uploaded {ago(match.uploadedAt)}
          </p>
        </div>
      </TriageCard>
    {/if}

    {#if poiMatch}
      <SharedFileCard
        row={{
          modelId: row.modelId,
          modelName: row.modelName,
          userId: row.userId,
          username: row.username,
          hash: poiMatch.hash,
          fileName: poiMatch.fileName,
          fileSizeKB: poiMatch.fileSizeKB,
          modelVersionId: poiMatch.modelVersionId,
          minorModelId: poiMatch.seedModelId ?? undefined,
          minorModelName: poiMatch.seedModelName,
          minorModelVersionId: poiMatch.seedModelVersionId,
        }}
        {civitaiUrl}
        label="poi"
        status={{ label: 'not flagged', tone: 'green' }}
      />
      <TriageCard dense title={match ? 'Why no real-person flag was applied' : 'Why nothing was applied'}>
        <div class="space-y-2 text-dark-0">
          <!-- Why it was queued is not stored, and the seeds may have changed since, so this says
               only what queueing guarantees. -->
          <p class="m-0">
            When the match was made, no model from the same uploader with a moderator behind its
            real-person flag shared this file, so the flag was not copied over automatically.
            Decide whether this upload is the same content under a new name.
          </p>
          {#if poiMatch.matchedAt}
            <p class="m-0 text-[11px] text-dark-2" title={dateTime(poiMatch.matchedAt)}>
              hash sweep · matched {ago(poiMatch.matchedAt)}
            </p>
          {/if}
        </div>
      </TriageCard>
    {/if}

    {#if detections.length}
      <TriageCard dense title="Why it was detected">
        <div class="space-y-3">
          {#each detections as flag (flag.label)}
            {@const detection = flag.redetected!}
            <FlagVerdictBlock label={flag.label} reason={detection.reason} applied={false}>
              {#snippet provenance()}
                <ScanProvenance
                  at={detection.at}
                  source={flagScanSource(detection.workflowId, row.scanRows)}
                  promptId={flagPromptId(detection.promptIds, flag.label)}
                  {detail}
                /> · {detectionCopy(detectionKind(detection)).provenance}
              {/snippet}
              {#if flag.label === 'poi' ? row.poi : row.minor}
                <p class="m-0 text-[11px] text-dark-2">The model already carries this flag.</p>
              {/if}
            </FlagVerdictBlock>
          {/each}
        </div>
      </TriageCard>
      <!-- The scan writes every label it detects from one text; no excerpt of it is stored. -->
      {#if scanned}
        <ScannedNamesCard
          {names}
          textHash={scanned.textHash}
          since={textSinceFlag(scanned.textHash, row.scanRows)}
          subject="detection"
        />
      {/if}
    {/if}

    <!-- One history card per held label: a ruling stub records no label of its own. -->
    {#each detections as flag, i (flag.label)}
      {@const sections = detectionSections(detectionKind(flag.redetected!), flag.rulings)}
      <PriorRulingsCard
        title={detections.length > 1
          ? `Prior rulings and appeals: ${FLAG_LABEL_NAMES[flag.label]}`
          : undefined}
        granted={flag.granted}
        grantedByUsername={flag.grantedByUsername}
        rulings={flag.rulings}
        showPriorClear={sections.priorClear}
        showRulings={sections.rulings}
        pastAppeals={i === 0 ? row.pastAppeals : undefined}
        sameFileAppeals={i === 0 ? row.sameFileAppeals : undefined}
        appealOpen={i === 0 ? row.hasPendingAppeal : undefined}
      />
    {/each}

  {/snippet}

  {#snippet decision()}
    <FlagDecisionForm
      modelId={row.modelId}
      flags={leads}
      {decisions}
      hasPendingAppeal={row.hasPendingAppeal}
      {submit}
      {actionHref}
      hint="Nothing is applied until you decide. A decision on a detection is stored as a labelled example for tuning the text-scan prompts."
      bind:draft
    />
  {/snippet}
</ModelFlagDetailFrame>

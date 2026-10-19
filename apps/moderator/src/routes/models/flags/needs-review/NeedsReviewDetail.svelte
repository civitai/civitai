<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { browser } from '$app/environment';
  import { page } from '$app/state';
  import { IconMessage } from '@tabler/icons-svelte';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
  import CrossTabChips from '$lib/components/minor-flags/CrossTabChips.svelte';
  import EnforcementChip from '$lib/components/minor-flags/EnforcementChip.svelte';
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import FlagDecisionForm from '$lib/components/minor-flags/FlagDecisionForm.svelte';
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
  import type { RulingDraft } from '$lib/components/RulingForm.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { ago, modelUrl } from '$lib/minor-flags/appeal-row';
  import { crossTabChips } from '$lib/minor-flags/cross-tab';
  import { FLAG_LABEL_NAMES, needsReviewDecisions } from '$lib/minor-flags/flagged-decision';
  import { fetchModelFlagDetail, flagPromptId, textSinceFlag } from '$lib/minor-flags/model-detail';
  import { leadRefs } from '$lib/minor-flags/needs-review';
  import { MODEL_FLAGS_APPEALS_PATH, MODEL_FLAGS_NEEDS_REVIEW_PATH } from '$lib/minor-flags/paths';
  import { SSR_PENDING } from '$lib/ssr-pending';
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
    verdict,
    error,
    submit,
    actionHref,
    draft = $bindable(),
  }: {
    row: NeedsReviewRow;
    civitaiUrl: string;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    draft: RulingDraft<Verdict>;
  } = $props();

  const heldTabs = $derived(
    (page.data.modelFlagTabs ?? []).map((tab: { href: string }) => tab.href) as string[]
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
  const leads = $derived(leadRefs(row));
  const labels = $derived([...new Set(leads.map((f) => f.label))]);
  const decisions = $derived(needsReviewDecisions(leads));

  // Derived, never an effect: the shell keys the detail per row. Primitives first, so a reload that
  // hands back an equal row keeps the request.
  const modelId = $derived(row.modelId);
  const promptKey = $derived(
    detections
      .map((f) => flagPromptId(f.redetected?.promptIds, f.label))
      .filter((id): id is number => id !== null)
      .join(',')
  );
  const detail = $derived(
    browser
      ? fetchModelFlagDetail(
          MODEL_FLAGS_NEEDS_REVIEW_PATH,
          modelId,
          promptKey ? promptKey.split(',').map(Number) : []
        )
      : SSR_PENDING
  );
</script>

<TriageDetailFrame {verdict} {error}>
  {#snippet children()}
    <ModelDetailHeader
      modelId={row.modelId}
      modelName={row.modelName}
      userId={row.userId}
      {civitaiUrl}
      {detail}
    >
      {#snippet chips()}
        <EnforcementChip applied={false} />
        {#each detections as flag (flag.label)}<FlaggedSourceBadge row={flag} />{/each}
        {#if match}<MetaChip tone="blue">hash</MetaChip>{/if}
        {#each labels as label (label)}<FlagBadge {label} />{/each}
        {#if match}<MetaChip tone="amber">different uploader</MetaChip>{/if}
        <CrossTabChips chips={alsoIn} linked />
      {/snippet}
    </ModelDetailHeader>

    <PreviewImagesCard
      images={row.coverImages}
      allHref={modelUrl(civitaiUrl, row.modelId)}
      {detail}
    />

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

    {#each detections as flag (flag.label)}
      {@const detection = flag.redetected!}
      {@const copy = detectionCopy(detectionKind(detection))}
      <div class={detection.names?.length ? 'grid gap-4 md:grid-cols-[1fr_minmax(320px,380px)]' : ''}>
        <ScannedTextCard
          title={leads.length > 1
            ? `Why it was detected: ${FLAG_LABEL_NAMES[flag.label]}`
            : 'Why it was detected'}
          label={flag.label}
          {detection}
          flagged={flag.label === 'poi' ? row.poi : row.minor}
          explanation={copy.explanation}
        />
        {#if detection.names?.length}
          <ScannedNamesCard
            names={detection.names}
            textHash={detection.textHash}
            since={textSinceFlag(flag.textHash, row.scanRows)}
          />
        {/if}
      </div>
    {/each}

    {#if match}
      <div class="grid items-start gap-4 lg:grid-cols-[1fr_400px]">
        <TriageCard dense title="Why it is here">
          <div class="space-y-2 text-dark-0">
            <p class="m-0">
              Its main file is byte-identical to a file in a model a moderator flagged as minor.
              The uploader is a different account, so nothing was applied automatically. Decide
              whether this upload is the same content under a new name.
            </p>
            <!-- No match timestamp is stored, so the shared file's upload stands in for when the
                 sweep could first have seen it. -->
            <p class="m-0 text-[11px] text-dark-2" title={dateTime(match.uploadedAt)}>
              hash sweep · file uploaded {ago(match.uploadedAt)}
            </p>
          </div>
        </TriageCard>
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
      </div>
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
        appealOpen={i === 0 ? row.hasPendingAppeal : undefined}
      />
    {/each}

    <div class="grid gap-4 md:grid-cols-2">
      <ModelFactsCard {row} {detail} />
      <UploaderCard {row} {detail} />
    </div>
  {/snippet}
  {#snippet actions()}
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
</TriageDetailFrame>

<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { browser } from '$app/environment';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { IconMessage } from '@tabler/icons-svelte';
  import { page } from '$app/state';
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import FlagVerdictBlock from '$lib/components/minor-flags/FlagVerdictBlock.svelte';
  import FlaggedSourceBadge from '$lib/components/minor-flags/FlaggedSourceBadge.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import ModelDetailHeader from '$lib/components/minor-flags/ModelDetailHeader.svelte';
  import ModelFactsCard from '$lib/components/minor-flags/ModelFactsCard.svelte';
  import PreviewImagesCard from '$lib/components/minor-flags/PreviewImagesCard.svelte';
  import PriorRulingsCard from '$lib/components/minor-flags/PriorRulingsCard.svelte';
  import ScanProvenance from '$lib/components/minor-flags/ScanProvenance.svelte';
  import ScannedNamesCard from '$lib/components/minor-flags/ScannedNamesCard.svelte';
  import ScannedTextCard from '$lib/components/minor-flags/ScannedTextCard.svelte';
  import SharedFileCard from '$lib/components/minor-flags/SharedFileCard.svelte';
  import UploaderCard from '$lib/components/minor-flags/UploaderCard.svelte';
  import type { RulingDraft } from '$lib/components/RulingForm.svelte';
  import InlineReasonFields from '$lib/components/triage/InlineReasonFields.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { ago, modelUrl } from '$lib/minor-flags/appeal-row';
  import {
    FLAG_LABEL_NAMES,
    decisionEnabled,
    flaggedDecisions,
    flaggedReasonGroups,
    planDecision,
    planReasonProblem,
    type FlagRef,
  } from '$lib/minor-flags/flagged-decision';
  import {
    HASH_FLAG_REASON,
    fetchModelFlagDetail,
    flagPromptId,
    hashSweepText,
    flagScanSource,
    textSinceFlag,
  } from '$lib/minor-flags/model-detail';
  import { MODEL_FLAGS_APPEALS_PATH, MODEL_FLAGS_REVIEW_PATH } from '$lib/minor-flags/paths';
  import { SSR_PENDING } from '$lib/ssr-pending';
  import {
    detectionCopy,
    detectionKind,
    detectionSections,
    latestScanDisagrees,
    scanVerdictProvenance,
  } from '$lib/minor-flags/text-scan-verdicts';
  import {
    decisionReasonOptions,
    suggestedReason,
  } from '$lib/triage/decision-reasons';
  import type { FlaggedFlagItem, FlaggedRow } from '$lib/server/minor-hash.service';
  import type { Outcome } from '$lib/triage/queue';
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
  // ruling either way. Lifting a hash or text-scan flag is allowed. Change with `flaggedDecisionEnabled`.
  const APPEAL_FIRST = "Resolve the owner's open appeal first.";
  const canOpenAppeals = $derived(
    page.data.modelFlagTabs?.some((tab: { href: string }) => tab.href === MODEL_FLAGS_APPEALS_PATH)
  );
  const appealsHref = $derived(`${MODEL_FLAGS_APPEALS_PATH}?q=${row.modelId}`);

  const flags = $derived(row.flags);
  const flagRefs: FlagRef[] = $derived(
    flags.map(({ label, source, textHash }) => ({ label, source, textHash }))
  );
  const redetections = $derived(flags.filter((f) => f.source === 'redetected' && f.redetected));
  const textScans = $derived(flags.filter((f) => f.source === 'text-scan'));
  const hashFlag = $derived(flags.find((f) => f.source === 'hash') ?? null);
  const sources = $derived([...new Map(flags.map((f) => [f.source, f])).values()]);
  const labels = $derived([...new Set(flags.map((f) => f.label))]);

  // Derived, never an effect: the shell keys the detail per row. Primitives first, so a reload that
  // hands back an equal row keeps the request.
  const modelId = $derived(row.modelId);
  const promptIdOf = (flag: FlaggedFlagItem) =>
    flagPromptId((flag.scanEntry ?? flag.redetected)?.promptIds, flag.label);
  const promptKey = $derived(
    flags
      .map(promptIdOf)
      .filter((id): id is number => id !== null)
      .join(',')
  );
  const detail = $derived(
    browser
      ? fetchModelFlagDetail(
          MODEL_FLAGS_REVIEW_PATH,
          modelId,
          promptKey ? promptKey.split(',').map(Number) : []
        )
      : SSR_PENDING
  );
  // One scanned-text card per row: the scan writes every label it flags from one text.
  const scanned = $derived(textScans.find((f) => f.textHash) ?? null);
  const names = $derived([...new Set(textScans.flatMap((f) => f.scanEntry?.names ?? []))]);
  const since = $derived(textSinceFlag(scanned?.textHash, row.scanRows));

  const decisions = $derived(flaggedDecisions(flagRefs));
  const withAppeal = $derived(flags.map((f) => ({ ...f, hasPendingAppeal: row.hasPendingAppeal })));
  const enabled = $derived(decisions.map((d) => decisionEnabled(withAppeal, d)));
  const reasonGroups = $derived(
    flaggedReasonGroups(flagRefs, { keep: decisions[0].label, revert: decisions[1].label })
  );
  const reasonOptions = $derived(reasonGroups ? decisionReasonOptions(reasonGroups) : null);
  // Confirming takes one key when keeping has a single specific reason.
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
              planDecision(flagRefs, decisions[index].keep),
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

{#snippet appealNotice()}
  <div
    class="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 text-xs leading-[1.45] text-amber-200"
  >
    <IconMessage class="mt-px size-3.5 shrink-0" aria-hidden="true" />
    <p class="m-0">
    The owner has an open appeal on this model. Reverting a flag here closes it with the same reason;
    keeping a flag has to wait for the appeal.
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
        {#each sources as flag (flag.source)}<FlaggedSourceBadge row={flag} />{/each}
        {#each labels as label (label)}<FlagBadge {label} />{/each}
        {#if row.hasPendingAppeal}<MetaChip tone="amber">also in Appeals</MetaChip>{/if}
        {#if hashFlag?.daysLeft != null}
          <MetaChip tone="amber"
            >{hashFlag.daysLeft === 0
              ? 'review window closed'
              : `${hashFlag.daysLeft} d left in review window`}</MetaChip
          >
        {/if}
      {/snippet}
    </ModelDetailHeader>

    <PreviewImagesCard
      images={row.coverImages}
      allHref={modelUrl(civitaiUrl, row.modelId)}
      {detail}
    />

    {#each redetections as flag (flag.label)}
      {@const redetection = flag.redetected!}
      {@const copy = detectionCopy(detectionKind(redetection))}
      <div
        class={redetection.names?.length ? 'grid gap-4 md:grid-cols-[1fr_minmax(320px,380px)]' : ''}
      >
        <ScannedTextCard
          title={redetections.length > 1 || flags.length > 1
            ? `Why it was held: ${FLAG_LABEL_NAMES[flag.label]}`
            : 'Why it was held'}
          label={flag.label}
          detection={redetection}
          flagged={flag.label === 'poi' ? row.poi : row.minor}
          explanation={copy.explanation}
        />
        {#if redetection.names?.length}
          <ScannedNamesCard
            names={redetection.names}
            textHash={redetection.textHash}
            since={textSinceFlag(flag.textHash, row.scanRows)}
          />
        {/if}
      </div>
    {/each}

    {#if textScans.length || hashFlag}
      <div class="grid gap-4 {hashFlag ? 'lg:grid-cols-[1fr_400px]' : 'lg:grid-cols-[1fr_360px]'}">
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
        <div class="space-y-4">
          {#if names.length || scanned?.textHash}
            <ScannedNamesCard {names} textHash={scanned?.textHash} {since} />
          {/if}
          {#if hashFlag}
            <SharedFileCard {row} {civitaiUrl} status={{ label: 'under review', tone: 'blue' }} />
          {/if}
        </div>
      </div>
    {:else if row.hasPendingAppeal}
      {@render appealNotice()}
    {/if}

    <!-- One history card per label: a ruling stub records no label of its own. -->
    {#each labels as label, i (label)}
      {@const flag =
        flags.find((f) => f.label === label && f.source === 'redetected') ??
        flags.find((f) => f.label === label)!}
      {@const sections = flag.redetected
        ? detectionSections(detectionKind(flag.redetected), flag.rulings)
        : null}
      <PriorRulingsCard
        title={labels.length > 1
          ? `Prior rulings and appeals: ${FLAG_LABEL_NAMES[label]}`
          : undefined}
        granted={sections ? flag.granted : null}
        grantedByUsername={sections ? flag.grantedByUsername : null}
        rulings={flag.rulings}
        showPriorClear={sections?.priorClear ?? false}
        showRulings={sections?.rulings ?? true}
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
    <!-- One form, one button per decision: each button posts the flags it keeps. -->
    <form method="POST" action={actionHref('decideFlags')} use:enhance={decide} class="w-full">
      <input type="hidden" name="modelId" value={row.modelId} />
      <input type="hidden" name="flags" value={JSON.stringify(flagRefs)} />
      <TriageDecisionBar
        buttons={decisionButtons}
        fields={reasonOptions ? fields : undefined}
        {problem}
        hint={reasonOptions
          ? 'Every decision here is stored as a labelled example for tuning the text-scan prompts.'
          : undefined}
      />
    </form>
  {/snippet}
</TriageDetailFrame>

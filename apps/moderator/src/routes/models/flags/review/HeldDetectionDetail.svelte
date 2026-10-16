<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import DetectionKindBadge from '$lib/components/minor-flags/DetectionKindBadge.svelte';
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import ModelFactsCard from '$lib/components/minor-flags/ModelFactsCard.svelte';
  import UploaderCard from '$lib/components/minor-flags/UploaderCard.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS } from '$lib/format';
  import {
    detectionCopy,
    detectionKind,
    detectionSections,
  } from '$lib/minor-flags/text-scan-verdicts';
  import { MODEL_FLAGS_APPEALS_PATH } from '$lib/minor-flags/paths';
  import type { RedetectedRow } from '$lib/server/minor-hash.service';
  import PreviewImagesCard from '$lib/components/minor-flags/PreviewImagesCard.svelte';
  import PriorRulingsCard from '$lib/components/minor-flags/PriorRulingsCard.svelte';
  import ScannedTextCard from '$lib/components/minor-flags/ScannedTextCard.svelte';
  import RulingForm, { type RulingDraft } from '$lib/components/RulingForm.svelte';
  import { HELD_DETECTION_RULING_CHOICES } from '$lib/ruling-choices';
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
    row: RedetectedRow;
    civitaiUrl: string;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    draft: RulingDraft<Verdict>;
  } = $props();

  // Mirrors the main app's refusal in resolveTextScanRedetection: any Pending appeal on the model, for
  // either label, blocks a ruling. Change both together.
  const APPEAL_FIRST = "Resolve the owner's open appeal first.";
  const appealsHref = $derived(`${MODEL_FLAGS_APPEALS_PATH}?q=${row.modelId}`);
  const kind = $derived(detectionKind(row.redetected));
  const copy = $derived(detectionCopy(kind));
  const sections = $derived(detectionSections(kind, row.rulings));
  const blocked = $derived(row.hasPendingAppeal);
  const flagged = $derived(row.label === 'poi' ? row.poi : row.minor);
</script>

{#snippet verdictFields()}
  <input type="hidden" name="modelId" value={row.modelId} />
  <input type="hidden" name="label" value={row.label} />
  <input type="hidden" name="textHash" value={row.redetected.textHash} />
{/snippet}

<TriageDetailFrame {verdict} {error}>
  {#snippet children()}
    <header class="space-y-2">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <a
          href="{civitaiUrl}/models/{row.modelId}?view=basic"
          target="_blank"
          rel="noreferrer"
          class="text-lg font-semibold {LINK_CLASS}"
        >
          {row.modelName} ↗
        </a>
        <code class="text-sm text-dark-2">#{row.modelId}</code>
        <Badge variant="secondary" class="h-6 px-2.5 text-sm">{row.status}</Badge>
      </div>
      <div class="flex flex-wrap items-center gap-1.5 text-sm text-dark-2">
        <FlagBadge label={row.label} size="md" />
        <DetectionKindBadge {kind} size="md" />
        <span>
          by
          {#if row.username}
            <a href={userLookupUrl(row.userId)} class={LINK_CLASS}>{row.username}</a>
          {:else}
            user #{row.userId}
          {/if}
        </span>
      </div>
    </header>

    <PreviewImagesCard images={row.coverImages} />

    <div class="grid gap-4 lg:grid-cols-2">
      <ScannedTextCard
        title="Why it was held"
        label={row.label}
        detection={row.redetected}
        {flagged}
        explanation={copy.explanation}
      />
      <PriorRulingsCard
        granted={row.granted}
        grantedByUsername={row.grantedByUsername}
        rulings={row.rulings}
        showPriorClear={sections.priorClear}
        showRulings={sections.rulings}
      />
    </div>

    <ModelFactsCard {row} />

    <UploaderCard {row} />

    {#if blocked}
      <p class="m-0 text-sm text-dark-0">
        The owner has an open appeal; resolve it first.
        <a href={appealsHref} class={LINK_CLASS}>Open it</a>
      </p>
    {/if}
  {/snippet}
  {#snippet actions()}
    <RulingForm
      subject="heldDetection"
      choices={HELD_DETECTION_RULING_CHOICES}
      action={actionHref(draft.verdict === 'Kept' ? 'keepRedetected' : 'dismissRedetected')}
      enhancer={submit((form) => (form.get('status') === 'Kept' ? 'Flagged' : 'Not flagged'))}
      idPrefix="held-{row.modelId}-{row.label}"
      size="lg"
      kbd
      labels={[row.label]}
      disabled={blocked}
      choiceDisabled={() => (blocked ? APPEAL_FIRST : null)}
      bind:draft
    >
      {#snippet hidden()}
        {@render verdictFields()}
      {/snippet}
    </RulingForm>
  {/snippet}
</TriageDetailFrame>

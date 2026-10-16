<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Kbd } from '@civitai/ui/components/ui/kbd/index.js';
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import FlaggedSourceBadge from '$lib/components/minor-flags/FlaggedSourceBadge.svelte';
  import ModelFactsCard from '$lib/components/minor-flags/ModelFactsCard.svelte';
  import PreviewImagesCard from '$lib/components/minor-flags/PreviewImagesCard.svelte';
  import PriorRulingsCard from '$lib/components/minor-flags/PriorRulingsCard.svelte';
  import ScannedTextCard from '$lib/components/minor-flags/ScannedTextCard.svelte';
  import SharedFileCard from '$lib/components/minor-flags/SharedFileCard.svelte';
  import UploaderCard from '$lib/components/minor-flags/UploaderCard.svelte';
  import RulingForm, { type RulingDraft } from '$lib/components/RulingForm.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { ago } from '$lib/minor-flags/appeal-row';
  import { MODEL_FLAGS_APPEALS_PATH } from '$lib/minor-flags/paths';
  import {
    detectionCopy,
    detectionKind,
    detectionSections,
  } from '$lib/minor-flags/text-scan-verdicts';
  import { HELD_DETECTION_RULING_CHOICES } from '$lib/ruling-choices';
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

  // Mirrors the main app's refusal: an open appeal on the model blocks keeping a flag, for either
  // label. Lifting is allowed. Change both together.
  const APPEAL_FIRST = "Resolve the owner's open appeal first.";
  const blocked = $derived(row.hasPendingAppeal);
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

  const HASH_ACTIONS = [
    { action: 'keepFlag', label: 'Keep flag', outcome: 'Flag kept', variant: 'default' },
    { action: 'liftFlag', label: 'Lift flag', outcome: 'Flag lifted', variant: 'destructive' },
  ] as const;
</script>

{#snippet verdictFields()}
  <input type="hidden" name="modelId" value={row.modelId} />
  <input type="hidden" name="label" value={row.label} />
  <input type="hidden" name="source" value={row.source} />
  {#if row.textHash}<input type="hidden" name="textHash" value={row.textHash} />{/if}
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
        <FlaggedSourceBadge {row} size="md" />
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

    {#if redetection && copy && sections}
      <div class="grid gap-4 lg:grid-cols-2">
        <ScannedTextCard
          title="Why it was held"
          label={row.label}
          detection={redetection}
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
    {:else}
      <TriageCard title="Why it was flagged">
        <div class="space-y-2 text-base text-dark-0">
          <p class="m-0">
            Flagged automatically: a file in this model matches one from a model a moderator flagged
            as minor.
          </p>
          {#if row.flaggedAt}
            <p class="m-0 text-sm" title={dateTime(row.flaggedAt)}>
              Flagged {ago(row.flaggedAt)}{#if row.daysLeft !== null}
                · {row.daysLeft} day{row.daysLeft === 1 ? '' : 's'} left; after that the flag is
                presumed correct{/if}
            </p>
          {/if}
          {#if row.prevNsfw != null || row.prevGalleryLevel != null}
            <p class="m-0 text-sm">
              Before the flag: NSFW {row.prevNsfw ? 'on' : 'off'}{row.prevGalleryLevel != null
                ? `, gallery level ${row.prevGalleryLevel}`
                : ''}
            </p>
          {/if}
        </div>
      </TriageCard>
      <SharedFileCard {row} {civitaiUrl} />
      <PriorRulingsCard
        granted={null}
        grantedByUsername={null}
        rulings={row.rulings}
        showPriorClear={false}
        showRulings
      />
    {/if}

    <ModelFactsCard {row} />

    <UploaderCard {row} />

    {#if blocked}
      <p class="m-0 text-sm text-dark-0">
        <Badge variant="outline" class="mr-1 h-5 px-2 text-xs">also in Appeals</Badge>
        The owner has an open appeal; keeping the flag waits on it, lifting does not.
        {#if canOpenAppeals}<a href={appealsHref} class={LINK_CLASS}>Open it</a>{/if}
      </p>
    {/if}
  {/snippet}
  {#snippet actions()}
    {#if row.source === 'redetected'}
      <RulingForm
        subject="heldDetection"
        choices={HELD_DETECTION_RULING_CHOICES}
        action={actionHref(draft.verdict === 'Kept' ? 'keepFlag' : 'liftFlag')}
        enhancer={submit((form) => (form.get('status') === 'Kept' ? 'Flagged' : 'Not flagged'))}
        idPrefix="flagged-{row.modelId}-{row.label}"
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
    {:else}
      <!-- No reason form: the main app's confirm and revert endpoints record none yet. -->
      <div class="flex flex-wrap gap-3">
        {#each HASH_ACTIONS as choice, i (choice.action)}
          {@const unavailable = choice.action === 'keepFlag' && blocked ? APPEAL_FIRST : null}
          <form
            method="POST"
            action={actionHref(choice.action)}
            data-triage-action={choice.action}
            use:enhance={submit(choice.outcome)}
          >
            {@render verdictFields()}
            <Button
              type="submit"
              size="lg"
              class="h-11 px-5 text-base"
              variant={choice.variant}
              disabled={!!unavailable}
              title={unavailable ?? undefined}
            >
              {choice.label}
              <Kbd>{i + 1}</Kbd>
            </Button>
          </form>
        {/each}
      </div>
    {/if}
  {/snippet}
</TriageDetailFrame>

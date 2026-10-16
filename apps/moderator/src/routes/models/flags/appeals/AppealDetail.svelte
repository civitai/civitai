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
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Kbd } from '@civitai/ui/components/ui/kbd/index.js';
  import { LINK_CLASS } from '$lib/format';
  import type { MinorFlagAppealRow } from '$lib/server/minor-hash.service';
  import { modelUrl } from '$lib/minor-flags/appeal-row';
  import { flagInForce, poiInForce } from '$lib/minor-flags/text-scan-verdicts';
  import OwnerSaysCard from '$lib/components/minor-flags/OwnerSaysCard.svelte';
  import PreviewImagesCard from '$lib/components/minor-flags/PreviewImagesCard.svelte';
  import WhyFlaggedCard from '$lib/components/minor-flags/WhyFlaggedCard.svelte';
  import ResolutionReasonFields from '$lib/components/ResolutionReasonFields.svelte';
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

  const modelHref = (id: number) => modelUrl(civitaiUrl, id);

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

<TriageDetailFrame {verdict} {error}>
  {#snippet children()}
    <header class="space-y-2">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <a
          href={modelHref(row.modelId)}
          target="_blank"
          rel="noreferrer"
          class="text-lg font-semibold {LINK_CLASS}"
        >
          {row.modelName} ↗
        </a>
        <code class="text-sm text-dark-2">#{row.modelId}</code>
        <Badge variant="secondary" class="h-6 px-2.5 text-sm">{row.status}</Badge>
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        <AppealTags {row} size="md" />
      </div>
    </header>

    <PreviewImagesCard images={row.coverImages} modelHref={modelHref(row.modelId)} />

    <div class="grid gap-4 lg:grid-cols-2">
      <WhyFlaggedCard {row} {civitaiUrl} />
      <OwnerSaysCard message={row.appealMessage} appealedAt={row.appealCreatedAt} />
    </div>

    <ModelFactsCard {row} />

    <UploaderCard {row} />
  {/snippet}
  {#snippet actions()}
    {#each FLAG_APPEAL_RULING_CHOICES as c, i (c.verdict)}
      {@const blocked = c.verdict === 'Rejected' && !canUphold}
      <Button
        size="lg"
        class="h-11 px-5 text-base"
        variant={draft.verdict === c.verdict ? c.variant : 'outline'}
        aria-pressed={draft.verdict === c.verdict}
        disabled={blocked}
        title={blocked ? 'Not flagged any more. Unflag closes the request.' : undefined}
        onclick={() => choose(c.verdict)}
      >
        {c.label} <Kbd>{i + 1}</Kbd>
      </Button>
    {/each}
    {#if row.minor && poiOpen}
      {#each SPLIT_RULINGS as split (split)}
        <Button
          size="lg"
          variant={draft.verdict === split ? 'default' : 'outline'}
          class="h-11 text-base"
          aria-pressed={draft.verdict === split}
          onclick={() => choose(split)}
        >
          {RULINGS[split].label}
        </Button>
      {/each}
    {/if}
    {#if ruling}
      <!-- Keyed: `use:enhance` reads its handler once, and each ruling reports its own outcome. -->
      {#key draft.verdict}
        <form
          method="POST"
          action={actionHref(ruling.action)}
          use:enhance={submit(ruling.outcome)}
          class="grid w-full gap-2 rounded-md border border-dark-4 bg-dark-7 p-3"
        >
          <input type="hidden" name="modelId" value={row.modelId} />
          {#if ruling.split}
            <input type="hidden" name="minor" value={ruling.split.minor} />
            <input type="hidden" name="poi" value={ruling.split.poi} />
          {/if}
          <ResolutionReasonFields
            subject="flagAppeal"
            verdict={ruling.verdict}
            idPrefix="flag-appeal-{row.appealId}"
            labels={ruledOn}
            bind:reason={() => draft.reason, (reason) => (draft = { ...draft, reason })}
            bind:note={() => draft.note, (note) => (draft = { ...draft, note })}
          />
          <div>
            <Button
              type="submit"
              size="lg"
              variant={ruling.variant}
              disabled={unavailable || !!unrecordable}
            >
              {ruling.confirmLabel}
            </Button>
          </div>
        </form>
      {/key}
    {/if}
  {/snippet}
</TriageDetailFrame>

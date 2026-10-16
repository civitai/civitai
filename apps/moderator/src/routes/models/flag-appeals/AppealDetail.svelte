<script module lang="ts">
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
  import type { ButtonVariant } from '@civitai/ui/components/ui/button/index.js';
  import { FLAG_APPEAL_RULING_CHOICES } from '$lib/ruling-choices';

  type Decision = 'uphold' | 'overturn';
  type Ruling = {
    action: 'upholdAppeal' | 'overturnAppeal' | 'splitAppeal';
    verdict: ResolutionVerdict<'flagAppeal'>;
    label: string;
    confirmLabel: string;
    variant: ButtonVariant;
    /** What the item shows once decided. */
    outcome: string;
    labels?: { minor: Decision; poi: Decision };
  };

  const choice = (verdict: ResolutionVerdict<'flagAppeal'>) =>
    FLAG_APPEAL_RULING_CHOICES.find((c) => c.verdict === verdict)!;

  // A split lifts one flag, so the appeal closes Approved and takes an Approved reason.
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
      labels: { minor: 'uphold', poi: 'overturn' },
    },
    liftMinor: {
      action: 'splitAppeal',
      verdict: 'Approved',
      label: 'Lift minor, keep real person',
      confirmLabel: 'Confirm lift minor, keep real person',
      variant: 'default',
      outcome: 'Lifted minor, kept real person',
      labels: { minor: 'overturn', poi: 'uphold' },
    },
  } satisfies Record<string, Ruling>;

  export type AppealRuling = keyof typeof RULINGS;
  const SPLIT_RULINGS = ['liftPoi', 'liftMinor'] as const satisfies readonly AppealRuling[];
</script>

<script lang="ts">
  import { enhance } from '$app/forms';
  import { browser } from '$app/environment';
  import type { SubmitFunction } from '@sveltejs/kit';
  import ModelFactsCard from '$lib/components/minor-flags/ModelFactsCard.svelte';
  import UploaderCard from '$lib/components/minor-flags/UploaderCard.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Kbd } from '@civitai/ui/components/ui/kbd/index.js';
  import { LINK_CLASS, dateTime, shortAge } from '$lib/format';
  import type { MinorFlagAppealRow } from '$lib/server/minor-hash.service';
  import { effectiveSource, sourceLabel } from '$lib/minor-flags/appeal-filters';
  import { fetchHashDetail } from '$lib/minor-flags/hash-detail';
  import {
    flagInForce,
    latestScanDisagrees,
    openVerdicts,
    poiInForce,
    scanVerdictProvenance,
    scanVerdictText,
    type FlagLabel,
  } from '$lib/minor-flags/text-scan-verdicts';
  import AppealImages from '$lib/components/minor-flags/AppealImages.svelte';
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

  const ruling = $derived<Ruling | null>(draft.verdict ? RULINGS[draft.verdict] : null);
  const unrecordable = $derived(
    ruling ? resolutionReasonError('flagAppeal', ruling.verdict, draft.reason, draft.note) : null
  );

  const modelHref = (id: number, versionId: number | null = null) =>
    `${civitaiUrl}/models/${id}?view=basic${versionId ? `&modelVersionId=${versionId}` : ''}`;

  const origin = $derived(effectiveSource(row.flagSource, row.flagConfirmedFrom));
  const verdicts = $derived(openVerdicts(row.textScanFlags));
  const scan = $derived(row.latestScan);
  const scanLabels = $derived(
    (['minor', 'poi'] as const).flatMap((label) => {
      const value = scan?.[label];
      return value ? [{ label, value }] : [];
    })
  );
  const labelName = (label: FlagLabel) => (label === 'poi' ? 'real person' : 'minor');
  const poiOpen = $derived(poiInForce(row));
  const canUphold = $derived(flagInForce(row));
  const ago = (value: Date | string) => `${shortAge(value)} ago`;

  // Primitives first, so a reload that hands back an equal row doesn't rebuild the promise.
  const modelId = $derived(row.modelId);
  const isHash = $derived(origin === 'hash');
  // Derived, not an effect: the component is keyed per appeal, so a late response can't land on another one.
  const hashDetail = $derived(browser && isHash ? fetchHashDetail(modelId) : null);
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

    <AppealImages images={row.coverImages} />

    <div class="grid gap-4 lg:grid-cols-2">
      <TriageCard title="Why it was flagged">
        <div class="space-y-2 text-base text-dark-0">
          <p class="m-0">{sourceLabel(row.flagSource, row.flagConfirmedFrom)}</p>

          {#if row.flaggedAt}
            <p class="m-0 text-sm" title={dateTime(row.flaggedAt)}>Flagged {ago(row.flaggedAt)}</p>
          {/if}
          {#if row.flaggedByUsername}
            <p class="m-0 text-sm">
              Set by <span class="font-medium text-white">{row.flaggedByUsername}</span>
              {#if row.flaggedByAt}
                <span title={dateTime(row.flaggedByAt)}>{ago(row.flaggedByAt)}</span>
              {/if}
            </p>
          {/if}

          {#each verdicts as { label, flag } (label)}
            <div class="rounded-md bg-dark-6 p-3 text-sm">
              <p class="m-0 font-medium text-white">
                Text scan: {labelName(label)}
                {#if flag.at}
                  <span class="font-normal text-dark-2" title={dateTime(flag.at)}>
                    · flagged {ago(flag.at)}
                  </span>
                {/if}
              </p>
              {#if flag.reason}<p class="m-0 mt-1">{flag.reason}</p>{/if}
              {#if flag.names?.length}
                <p class="m-0 mt-1">Names: {flag.names.join(', ')}</p>
              {/if}
              {#if latestScanDisagrees(scan, label)}
                <p
                  class="m-0 mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200"
                >
                  Latest scan: not detected — flag kept (sticky)
                </p>
              {/if}
            </div>
          {/each}

          {#if verdicts.length || scanLabels.length}
            <div class="rounded-md bg-dark-6 p-3 text-sm">
              <p class="m-0 font-medium text-white">Latest scan</p>
              {#each scanLabels as { label, value } (label)}
                {@const provenance = scanVerdictProvenance(value)}
                <p class="m-0 mt-1">
                  <span class="text-white">{labelName(label)}:</span>
                  {scanVerdictText(value)}
                </p>
                <p class="m-0 text-dark-2">
                  {provenance.source} ·
                  {#if provenance.note}
                    <span title={dateTime(value.updatedAt)}>{provenance.note}</span>
                  {:else}
                    <span title={dateTime(value.updatedAt)}>{ago(value.updatedAt)}</span>
                  {/if}
                </p>
              {:else}
                <p class="m-0 text-sm text-dark-2">No text scan on record.</p>
              {/each}
            </div>
          {/if}

          {#if hashDetail}
            {#await hashDetail}
              <p class="m-0 text-sm text-dark-2">Looking up the matched model…</p>
            {:then payload}
              {#if payload.match}
                {@const m = payload.match}
                {@const d = payload.detail}
                <div class="rounded-md bg-dark-6 p-3 text-sm">
                  <p class="m-0">
                    Shares a file with
                    <a
                      href={modelHref(m.minorModelId, m.minorModelVersionId)}
                      target="_blank"
                      rel="noreferrer"
                      class={LINK_CLASS}
                    >
                      {m.minorModelName ?? `#${m.minorModelId}`} ↗
                    </a>
                    {#if d?.minorUsername}by {d.minorUsername}{/if}
                    {#if d?.minorModelStatus}({d.minorModelStatus}){/if}
                  </p>
                  {#if d?.minorModelDeletedAt}
                    <p class="m-0 mt-1">Deleted {dateTime(d.minorModelDeletedAt)}</p>
                  {/if}
                  <p class="m-0 mt-1 text-xs break-all text-dark-2">SHA256 <code>{m.hash}</code></p>
                </div>
              {:else}
                <p
                  class="m-0 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200"
                >
                  No flagged model shares a file with this one any more. The match is resolved live,
                  so the model it matched was unflagged or its hashes were deleted. Check before you
                  keep the flag.
                </p>
              {/if}
            {:catch}
              <p class="m-0 text-sm text-red-300">Could not load the matched model.</p>
            {/await}
          {/if}

          {#if row.prevNsfw != null || row.prevGalleryLevel != null}
            <p class="m-0 text-sm">
              Before the flag: NSFW {row.prevNsfw ? 'on' : 'off'}{row.prevGalleryLevel != null
                ? `, gallery level ${row.prevGalleryLevel}`
                : ''}
            </p>
          {/if}

          {#if !canUphold}
            <p class="m-0 text-sm text-emerald-300">
              The flag is already lifted, so upholding has nothing left to keep.
            </p>
          {/if}
        </div>
      </TriageCard>

      <TriageCard title="What the owner says">
        {#if row.appealMessage}
          <p class="m-0 text-base break-words whitespace-pre-wrap text-dark-0">
            {row.appealMessage}
          </p>
        {:else}
          <p class="m-0 text-base text-dark-0">The owner left no message.</p>
        {/if}
        <p class="m-0 mt-3 text-sm text-dark-2" title={dateTime(row.appealCreatedAt)}>
          Appealed {ago(row.appealCreatedAt)}, waiting {shortAge(row.appealCreatedAt)}
        </p>
      </TriageCard>
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
      <form
        method="POST"
        action={actionHref(ruling.action)}
        use:enhance={submit(ruling.outcome)}
        class="grid w-full gap-2 rounded-md border border-dark-4 bg-dark-7 p-3"
      >
        <input type="hidden" name="modelId" value={row.modelId} />
        {#if ruling.labels}
          <input type="hidden" name="minor" value={ruling.labels.minor} />
          <input type="hidden" name="poi" value={ruling.labels.poi} />
        {/if}
        <ResolutionReasonFields
          subject="flagAppeal"
          verdict={ruling.verdict}
          idPrefix="flag-appeal-{row.appealId}"
          bind:reason={() => draft.reason, (reason) => (draft = { ...draft, reason })}
          bind:note={() => draft.note, (note) => (draft = { ...draft, note })}
        />
        <div>
          <Button type="submit" size="lg" variant={ruling.variant} disabled={!!unrecordable}>
            {ruling.confirmLabel}
          </Button>
        </div>
      </form>
    {/if}
  {/snippet}
</TriageDetailFrame>

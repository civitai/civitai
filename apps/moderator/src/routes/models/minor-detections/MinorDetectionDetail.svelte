<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Kbd } from '@civitai/ui/components/ui/kbd/index.js';
  import DetectionKindBadge from '$lib/components/minor-flags/DetectionKindBadge.svelte';
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import ModelFactsCard from '$lib/components/minor-flags/ModelFactsCard.svelte';
  import UploaderCard from '$lib/components/minor-flags/UploaderCard.svelte';
  import TriageCard from '$lib/components/minor-flags/TriageCard.svelte';
  import TriageDetailFrame from '$lib/components/minor-flags/TriageDetailFrame.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, shortAge } from '$lib/format';
  import {
    clearViaLabel,
    detectionCopy,
    detectionKind,
    rulingText,
  } from '$lib/minor-flags/text-scan-verdicts';
  import { FLAG_APPEALS_PATH } from '$lib/minor-flags/paths';
  import type { RedetectedRow } from '$lib/server/minor-hash.service';
  import AppealImages from '$lib/components/minor-flags/AppealImages.svelte';

  let {
    row,
    civitaiUrl,
    verdict,
    error,
    submit,
    actionHref,
  }: {
    row: RedetectedRow;
    civitaiUrl: string;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: string) => SubmitFunction;
    actionHref: (action: string) => string;
  } = $props();

  // Mirrors the main app's refusal in resolveTextScanRedetection: any Pending appeal on the model, for
  // either label, blocks a ruling. Change both together.
  const APPEAL_FIRST = "Resolve the owner's open appeal first.";
  const ago = (value: string) => `${shortAge(value)} ago`;
  const appealsHref = $derived(`${FLAG_APPEALS_PATH}?q=${row.modelId}`);
  const kind = $derived(detectionKind(row.redetected));
  const copy = $derived(detectionCopy(kind));
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

    <AppealImages images={row.coverImages} />

    <div class="grid gap-4 lg:grid-cols-2">
      <TriageCard title="Why it was held">
        <div class="space-y-2 text-base text-dark-0">
          <p class="m-0">
            Text scan: {row.label === 'poi' ? 'real person' : 'minor'}
            {#if row.redetected.at}
              <span class="text-sm text-dark-2" title={dateTime(row.redetected.at)}>
                · detected {ago(row.redetected.at)}
              </span>
            {/if}
          </p>
          <p class="m-0 text-sm">{row.redetected.reason ?? 'No reason recorded.'}</p>
          {#if row.redetected.names?.length}
            <p class="m-0 text-sm">Names: {row.redetected.names.join(', ')}</p>
          {/if}
          <p class="m-0 text-sm">
            Now:
            <span class={flagged ? 'font-medium text-red-300' : 'font-medium text-emerald-300'}>
              {flagged ? 'Currently flagged' : 'Not flagged'}
            </span>
          </p>
          <p class="m-0 text-sm text-dark-2">
            {copy.explanation}
          </p>
        </div>
      </TriageCard>

      {#if copy.showsPriorClear}
      <TriageCard title="Previously cleared">
        <div class="space-y-2 text-base text-dark-0">
          {#if row.granted}
            <p class="m-0">
              {clearViaLabel(row.granted.via)}
              {#if row.grantedByUsername}
                by <span class="font-medium text-white">{row.grantedByUsername}</span>
              {:else if row.granted.by}
                by user #{row.granted.by}
              {/if}
              {#if row.granted.at}
                <span class="text-sm text-dark-2" title={dateTime(row.granted.at)}>
                  · {ago(row.granted.at)}
                </span>
              {/if}
            </p>
          {:else}
            <p class="m-0">No clearing record.</p>
          {/if}
          {#if row.rulings?.length}
            <div class="rounded-md bg-dark-6 p-3 text-sm">
              <p class="m-0 font-medium text-white">Earlier rulings</p>
              {#each row.rulings as ruling (`${ruling.decision}:${ruling.at}:${ruling.by}`)}
                <p class="m-0 mt-1">
                  {rulingText(ruling.decision, ruling.via)}
                  {#if ruling.by}by user #{ruling.by}{/if}
                  {#if ruling.at}
                    <span class="text-dark-2" title={dateTime(ruling.at)}>· {ago(ruling.at)}</span>
                  {/if}
                </p>
              {/each}
            </div>
          {/if}
        </div>
      </TriageCard>
      {/if}
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
    <form
      data-triage-action="uphold"
      method="POST"
      action={actionHref('keepRedetected')}
      use:enhance={submit('Flagged')}
    >
      {@render verdictFields()}
      <Button
        type="submit"
        size="lg"
        class="h-11 px-5 text-base"
        disabled={blocked}
        title={blocked ? APPEAL_FIRST : undefined}
      >
        Flag <Kbd>1</Kbd>
      </Button>
    </form>
    <form
      data-triage-action="overturn"
      method="POST"
      action={actionHref('dismissRedetected')}
      use:enhance={submit('Not flagged')}
    >
      {@render verdictFields()}
      <Button
        type="submit"
        size="lg"
        variant="destructive"
        class="h-11 px-5 text-base"
        disabled={blocked}
        title={blocked ? APPEAL_FIRST : undefined}
      >
        Don't flag <Kbd>2</Kbd>
      </Button>
    </form>
  {/snippet}
</TriageDetailFrame>

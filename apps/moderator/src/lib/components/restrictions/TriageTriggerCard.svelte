<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import PromptSegments from '$lib/components/PromptSegments.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { HIGHLIGHT_LEGEND, HIGHLIGHT_MARK } from '$lib/prompt-highlight';
  import { recheckCategories, type RecheckResult } from '$lib/restrictions/recheck';
  import { triggerOrigin, type SourceState } from '$lib/restrictions/origin';
  import {
    explainMatches,
    fieldLabel,
    hasNoRecordedMatch,
    highlightSets,
    humanizeCategory,
    isMissingFromText,
    promptTesterHref,
    sourceLabel,
  } from '$lib/restrictions/trigger-evidence';
  import { formatSpan, repeatSpanMs } from '$lib/restrictions/trigger-groups';
  import type {
    RemixSource,
    RestrictionTriggerView,
  } from '$lib/server/user-restriction.service';
  import HighlightedText from './HighlightedText.svelte';
  import PromptDiff from './PromptDiff.svelte';

  let {
    repeats,
    index,
    total,
    civitaiUrl,
    source,
    sourceState,
    selected,
    onToggle,
    recheck,
    recheckStatus,
  }: {
    /** Adjacent identical attempts; the first stands for all of them. */
    repeats: RestrictionTriggerView[];
    index: number;
    total: number;
    civitaiUrl: string;
    source: RemixSource | undefined;
    sourceState: SourceState | undefined;
    selected: boolean;
    onToggle: (keys: string[]) => void;
    /** The current word list run over a prompt that recorded no match; absent when not applicable. */
    recheck: RecheckResult | undefined;
    recheckStatus: 'loading' | 'failed' | undefined;
  } = $props();

  const trigger = $derived(repeats[0]);
  const count = $derived(repeats.length);
  const span = $derived(repeatSpanMs(repeats));
  const title = $derived(
    count > 1
      ? `Triggers ${index + 1}–${index + count} of ${total}`
      : `Trigger ${index + 1} of ${total}`
  );
  const origin = $derived(triggerOrigin(trigger));
  const matches = $derived(explainMatches(trigger));
  const highlights = $derived(highlightSets(matches));
  const testerLink = $derived(
    trigger.prompt
      ? promptTesterHref({ prompt: trigger.prompt, negativePrompt: trigger.negativePrompt })
      : null
  );
  const noRecordedMatch = $derived(hasNoRecordedMatch(trigger));
  const recheckCats = $derived(recheck ? recheckCategories(recheck) : []);
  const recheckLegend = $derived(HIGHLIGHT_LEGEND.filter((l) => recheckCats.includes(l.cat)));
  const awaitingRecheck = $derived(
    noRecordedMatch && trigger.source !== 'External' && !recheck && !!recheckStatus
  );
  const isRemix = $derived(origin.kind === 'remix' || origin.kind === 'legacy-remix');
  const canDiff = $derived(isRemix && !!source?.prompt && !!trigger.prompt);
  // A diff is only offered when the match was not already settled as identical.
  const showDiff = $derived(canDiff && origin.match !== 'identical');
  const compared = $derived(origin.match === 'edited' || origin.match === 'unrelated');
  // Keyed by source so a failure never carries over to a different source.
  let failedSourceId = $state<number | null>(null);
  const imageFailed = $derived(source !== undefined && failedSourceId === source.id);
</script>

<TriageCard {title}>
  <div class="space-y-4">
    {#if count > 1}
      <details class="rounded-md border border-dark-4 bg-dark-6 px-3 py-2">
        <summary class="cursor-pointer text-sm text-white">
          Submitted {count}×{span !== null ? ` · ${formatSpan(span)} apart` : ''}
          <span class="text-dark-2">· identical prompt and input, retried</span>
        </summary>
        <ul class="m-0 mt-2 list-none space-y-0.5 p-0 text-xs text-dark-0">
          {#each repeats as r (r.key)}
            <li>{r.time ? dateTime(r.time) : 'Time not recorded'}</li>
          {/each}
        </ul>
      </details>
    {/if}

    {#if origin.kind !== 'none'}
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-base font-medium text-white">{origin.label}</span>
          {#if (isRemix || origin.kind === 'enhancer') && !origin.verified}
            <Badge
              variant="outline"
              class="text-dark-2"
              title={isRemix
                ? 'The client claimed this source; the server could not confirm it.'
                : 'The server could not confirm this matches an enhancer output.'}
            >
              unverified
            </Badge>
          {/if}
          {#if origin.alsoEnhancer}
            <Badge variant="secondary">
              {origin.enhancerVerified
                ? 'also matches a prompt enhancer output'
                : 'may match a prompt enhancer output (unverified)'}
            </Badge>
          {/if}
        </div>

        {#if origin.incomplete && origin.kind !== 'incomplete'}
          <p class="m-0 text-sm text-amber-300">
            Origin lookup incomplete; the evidence shown may be partial.
          </p>
        {/if}

        {#if isRemix && origin.imageId}
          <div class="flex flex-wrap items-start gap-3">
            {#if source}
              <a
                href="{civitaiUrl}/images/{source.id}"
                target="_blank"
                rel="noreferrer"
                aria-label="Open the source image in a new tab"
                class="relative block size-28 shrink-0 overflow-hidden rounded-md border border-dark-4 bg-dark-7"
                onerrorcapture={() => (failedSourceId = source?.id ?? null)}
              >
                {#if imageFailed}
                  <span
                    class="flex size-full items-center justify-center p-2 text-center text-xs text-dark-2"
                  >
                    Image unavailable
                  </span>
                {:else}
                  <EdgeMedia
                    src={source.url}
                    type={source.type}
                    width={320}
                    class="size-full object-cover"
                  />
                {/if}
                <Badge variant="secondary" class="absolute top-1 left-1">
                  {getBrowsingLevelLabel(source.nsfwLevel)}
                </Badge>
              </a>
            {/if}
            <div class="space-y-1 text-sm">
              <a
                href="{civitaiUrl}/images/{origin.imageId}"
                target="_blank"
                rel="noreferrer"
                class={LINK_CLASS}
              >
                Open image #{origin.imageId} ↗
              </a>
              {#if !source}
                <p class="m-0 text-dark-2">
                  {sourceState === 'failed'
                    ? 'The source image could not be loaded.'
                    : sourceState === 'not-loaded'
                      ? 'The source image was not loaded for this page.'
                      : 'The source image is no longer available.'}
                </p>
              {:else if !source.prompt}
                <p class="m-0 text-dark-2">The source image has no stored prompt to compare.</p>
              {/if}
            </div>
          </div>
        {/if}

        {#if showDiff}
          <details class="rounded-md border border-dark-4 bg-dark-6 p-3">
            <summary class="cursor-pointer text-sm text-dark-0">
              {compared ? 'Source prompt vs submitted' : 'Not compared · view diff'}
            </summary>
            {#if !compared}
              <p class="mt-2 mb-0 text-xs text-dark-2">
                No automatic comparison was made for this trigger; the diff is shown for review.
              </p>
            {/if}
            <div class="mt-2">
              <PromptDiff source={source!.prompt!} submitted={trigger.prompt!} />
            </div>
          </details>
        {/if}
      </div>
    {/if}

    <div class="grid gap-4 md:grid-cols-[14rem_1fr]">
      <div class="flex flex-col gap-2">
        {#if trigger.category !== 'scam'}
          <div class="flex items-center gap-2">
            <Checkbox
              id="flag-{trigger.key}"
              bind:checked={() => selected, () => onToggle(repeats.map((r) => r.key))}
            />
            <Label for="flag-{trigger.key}" class="font-normal text-dark-0">
              False positive
            </Label>
          </div>
        {/if}

        <div class="flex flex-wrap items-center gap-2">
          {#if trigger.source}<Badge variant="outline">{sourceLabel(trigger.source)}</Badge>{/if}
          {#if trigger.category && !matches.length}
            <Badge variant="destructive">{humanizeCategory(trigger.category)}</Badge>
          {/if}
        </div>

        {#if matches.length}
          <div class="space-y-2">
            <p class="m-0 text-xs text-dark-2">Why blocked</p>
            {#each matches as m, i (i)}
              <div class="space-y-1 rounded-md border border-dark-4 bg-dark-6 p-2">
                {#if m.category}
                  <Badge variant="destructive">{humanizeCategory(m.category)}</Badge>
                {/if}
                {#if m.text}
                  <p class="m-0 text-xs text-dark-0">
                    <code class="break-all">"{m.text}"</code>
                    {m.field ? `in ${fieldLabel(m.field)}` : ''}
                    {#if isMissingFromText(m, trigger)}
                      <span class="text-dark-2">(not found in text)</span>
                    {/if}
                  </p>
                {/if}
                {#if m.gateWord}
                  <p class="m-0 text-xs text-dark-2">
                    with NSFW term <code class="break-all text-dark-0">"{m.gateWord}"</code>
                  </p>
                {/if}
                {#if m.regex}
                  <details>
                    <summary class="cursor-pointer text-xs text-dark-2">Pattern</summary>
                    <code class="text-xs break-all text-dark-0">{m.regex}</code>
                  </details>
                {/if}
              </div>
            {/each}
          </div>
        {:else if noRecordedMatch}
          <p class="m-0 text-xs text-dark-2">
            Match not recorded at block time.
            {#if testerLink}
              <a
                href={testerLink.href}
                title={testerLink.prefilled ? undefined : 'Prompt too long to prefill'}
                target="_blank"
                rel="noreferrer"
                class={LINK_CLASS}
              >
                Open in prompt tester ↗
              </a>
              {#if !testerLink.prefilled}
                <span>(prompt too long to prefill)</span>
              {/if}
            {/if}
          </p>
        {/if}
        {#if trigger.time}
          <div>
            <p class="m-0 text-xs text-dark-2">Time</p>
            <p class="m-0 text-xs text-dark-0">{dateTime(trigger.time)}</p>
          </div>
        {/if}
        {#if trigger.entityType}
          <div>
            <p class="m-0 text-xs text-dark-2">Entity</p>
            <p class="m-0 text-xs text-dark-0">{trigger.entityType} #{trigger.entityId}</p>
          </div>
        {/if}
        {#if trigger.cleanup}
          <div>
            <p class="m-0 text-xs text-dark-2">Hidden by the auto-mute</p>
            <p class="m-0 text-xs text-dark-0">
              {trigger.cleanup.count} ({trigger.cleanup.kind}){trigger.cleanup.truncated
                ? ', ids truncated'
                : ''}
            </p>
          </div>
        {/if}
      </div>

      <div class="min-w-0">
        {#if trigger.reason}
          <p class="mb-1 text-xs font-semibold tracking-wide text-dark-2 uppercase">Verdict</p>
          <p class="mb-2 text-sm text-dark-0">{trigger.reason}</p>
        {/if}
        {#if trigger.text}
          <p class="mb-1 text-xs font-semibold tracking-wide text-dark-2 uppercase">Scanned text</p>
          <div class="max-h-48 overflow-auto rounded-md border border-dark-4 bg-dark-7 p-2">
            <p class="m-0 text-sm break-words whitespace-pre-wrap text-dark-0">{trigger.text}</p>
          </div>
        {/if}
        {#if trigger.prompt}
          <div class="max-h-[32rem] overflow-auto rounded-md border border-dark-4 bg-dark-7 px-2 pb-2">
            <span
              class="sticky top-0 z-10 block bg-dark-7 py-1 text-xs font-semibold tracking-wide text-dark-2 uppercase"
            >
              Prompt
            </span>
            <HighlightedText text={trigger.prompt} highlight={highlights.prompt} />
          </div>
        {/if}
        {#if trigger.negativePrompt}
          <div
            class={[
              'max-h-48 overflow-auto rounded-md border border-dark-4 bg-dark-7 px-2 pb-2',
              trigger.prompt && 'mt-2',
            ]}
          >
            <span
              class="sticky top-0 z-10 block bg-dark-7 py-1 text-xs font-semibold tracking-wide text-dark-2 uppercase"
            >
              Negative
            </span>
            <HighlightedText
              text={trigger.negativePrompt}
              highlight={highlights.negativePrompt}
            />
          </div>
        {/if}

        {#if recheck}
          <div class="mt-2 space-y-2 rounded-md border border-dark-4 bg-dark-6 p-2">
            <p class="m-0 text-xs font-semibold tracking-wide text-dark-2 uppercase">
              Re-checked with the current word list
              <span class="font-normal tracking-normal normal-case">
                (not recorded at block time; text shown normalised)
              </span>
            </p>
            {#if recheckCats.length || recheck.wouldBlock}
              <p class="m-0 text-sm font-medium {recheck.wouldBlock ? 'text-red-300' : 'text-amber-300'}">
                {recheck.wouldBlock
                  ? 'Current word list would block this prompt'
                  : 'Current word list would NOT block this prompt'}
              </p>
              {#if !recheck.wouldBlock}
                <p class="m-0 text-xs text-dark-2">
                  Only terms that don't block on their own were found. This may have been a
                  warning, not a block.
                </p>
              {/if}
              <PromptSegments segments={recheck.prompt} />
              {#if recheck.negativePrompt && recheck.negativePrompt.some((s) => s.category)}
                <p class="m-0 text-xs text-dark-2">Negative prompt</p>
                <PromptSegments segments={recheck.negativePrompt} />
              {/if}
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dark-2">
                {#each recheckLegend as l (l.cat)}
                  <span class="inline-flex items-center gap-1">
                    <span class="inline-block size-3 rounded {HIGHLIGHT_MARK[l.cat]}"></span>
                    {l.label}
                  </span>
                {/each}
              </div>
            {:else}
              <p class="m-0 text-sm text-dark-0">
                The current word list finds no match. The rule may have changed since this was
                blocked.
              </p>
            {/if}
          </div>
        {:else if awaitingRecheck}
          <p class="mt-2 mb-0 text-xs text-dark-2">
            {recheckStatus === 'failed'
              ? 'Re-checking with the current word list failed.'
              : 'Re-checking with the current word list…'}
          </p>
        {/if}

        {#if trigger.inputImages?.length || trigger.inputVideo}
          <p class="mt-3 mb-1 text-xs font-semibold tracking-wide text-dark-2 uppercase">
            Input media
          </p>
          <div class="flex flex-wrap items-center gap-2">
            {#each trigger.inputImages ?? [] as url, i (`${i}:${url}`)}
              <a href={url} target="_blank" rel="noreferrer">
                <img
                  src={url}
                  alt="Input"
                  class="size-24 rounded border border-dark-4 object-cover"
                />
              </a>
            {/each}
            {#if trigger.inputVideo}
              <a
                href={trigger.inputVideo}
                target="_blank"
                rel="noreferrer"
                aria-label="Open the input video in a new tab"
              >
                <video
                  src={trigger.inputVideo}
                  muted
                  class="size-24 rounded border border-dark-4 object-cover"
                ></video>
              </a>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
</TriageCard>

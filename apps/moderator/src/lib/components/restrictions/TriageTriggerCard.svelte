<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import PromptSegments from '$lib/components/PromptSegments.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { HIGHLIGHT_LEGEND, HIGHLIGHT_MARK } from '$lib/prompt-highlight';
  import { normalisedDiffers, recheckCategories, type RecheckResult } from '$lib/restrictions/recheck';
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
  const position = $derived(count > 1 ? `#${index + 1}–${index + count}` : `#${index + 1}`);
  let timesOpen = $state(false);
  let promptOriginal = $state(false);
  let negativeOriginal = $state(false);
  const origin = $derived(triggerOrigin(trigger));
  const matches = $derived(explainMatches(trigger));
  const highlights = $derived(highlightSets(matches));
  const testerLink = $derived(
    trigger.prompt
      ? promptTesterHref({ prompt: trigger.prompt, negativePrompt: trigger.negativePrompt })
      : null
  );
  const noRecordedMatch = $derived(hasNoRecordedMatch(trigger));
  const awaitingRecheck = $derived(
    noRecordedMatch && trigger.source !== 'External' && !recheck && !!recheckStatus
  );
  const recheckCats = $derived(recheck ? recheckCategories(recheck) : []);
  const categoryName = (cat: string) => HIGHLIGHT_LEGEND.find((l) => l.cat === cat)?.label ?? cat;
  const legendFor = (segments: { category: string | null }[]) =>
    HIGHLIGHT_LEGEND.filter((l) => segments.some((seg) => seg.category === l.cat));
  const isRemix = $derived(origin.kind === 'remix' || origin.kind === 'legacy-remix');
  const canDiff = $derived(isRemix && !!source?.prompt && !!trigger.prompt);
  // A diff is only offered when the match was not already settled as identical.
  const showDiff = $derived(canDiff && origin.match !== 'identical');
  const compared = $derived(origin.match === 'edited' || origin.match === 'unrelated');
  // Keyed by source so a failure never carries over to a different source.
  let failedSourceId = $state<number | null>(null);
  const imageFailed = $derived(source !== undefined && failedSourceId === source.id);
</script>


{#snippet textBox(
  label: string,
  raw: string,
  segments: RecheckResult['prompt'] | null | undefined,
  highlight: string[],
  original: boolean,
  toggle: () => void,
  maxHeight: string
)}
  {@const showSegments = !!segments && !original}
  {@const differs = !!segments && normalisedDiffers(segments, raw)}
  {@const legend = showSegments ? legendFor(segments) : []}
  <div class="{maxHeight} overflow-auto rounded-md border border-dark-4 bg-dark-7 px-2 pb-2">
    <div class="sticky top-0 z-10 flex items-center gap-2 bg-dark-7 py-1">
      <span class="text-xs font-semibold tracking-wide text-dark-2 uppercase">{label}</span>
      {#if segments}
        <span
          class="text-xs text-dark-2 italic"
          title={showSegments
            ? 'Not recorded at block time; highlighted with the current word list'
            : 'The prompt as submitted'}
        >
          {showSegments ? 're-checked' : 'original'}
        </span>
      {:else if awaitingRecheck}
        <span class="text-xs text-dark-2 italic">
          {recheckStatus === 'failed' ? 're-check failed' : 're-checking…'}
        </span>
      {/if}
      {#if differs}
        <button type="button" class="ml-auto cursor-pointer text-xs {LINK_CLASS}" onclick={toggle}>
          {original ? 'show re-checked' : 'show original'}
        </button>
      {/if}
    </div>
    {#if showSegments}
      <PromptSegments {segments} />
    {:else}
      <HighlightedText text={raw} {highlight} />
    {/if}
    {#if legend.length}
      <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dark-2">
        {#each legend as l (l.cat)}
          <span class="inline-flex items-center gap-1">
            <span class="inline-block size-3 rounded {HIGHLIGHT_MARK[l.cat]}"></span>
            {l.label}
          </span>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<section class="rounded-xl border border-dark-4 bg-dark-7 p-4">
  <div class="space-y-3">
    <header class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span class="text-xs text-dark-2 tabular-nums">{position}</span>
      {#if origin.kind !== 'none'}
        <Badge variant="outline">{origin.label}</Badge>
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
      {/if}
      {#if count > 1}
        <button
          type="button"
          class="cursor-pointer"
          aria-expanded={timesOpen}
          title="Identical prompt and input, retried. Click for the attempt times."
          onclick={() => (timesOpen = !timesOpen)}
        >
          <Badge variant="secondary">
            {count}×{span !== null ? ` in ${formatSpan(span)}` : ''}
            {timesOpen ? '▴' : '▾'}
          </Badge>
        </button>
      {/if}
      {#if trigger.time}
        <span
          class="ml-auto text-xs text-dark-2"
          title={new Date(trigger.time).toISOString()}
        >
          {dateTime(trigger.time)}
        </span>
      {/if}
    </header>

    {#if timesOpen}
      <ul class="m-0 list-none space-y-0.5 p-0 text-xs text-dark-2">
        {#each repeats as r (r.key)}
          <li>{r.time ? dateTime(r.time) : 'Time not recorded'}</li>
        {/each}
      </ul>
    {/if}

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
      <details>
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

    <div class="grid gap-4 md:grid-cols-[14rem_1fr]">
      <div class="flex flex-col gap-3">
        {#if trigger.category !== 'scam'}
          <div class="flex items-center gap-2">
            <Checkbox
              id="flag-{trigger.key}"
              bind:checked={() => selected, () => onToggle(repeats.map((r) => r.key))}
            />
            <Label for="flag-{trigger.key}" class="font-normal text-dark-0">False positive</Label>
          </div>
        {/if}

        <div class="space-y-2">
          <p class="m-0 text-xs font-semibold tracking-wide text-dark-2 uppercase">Why blocked</p>
          <div class="flex flex-wrap items-center gap-2">
            {#if trigger.source}<Badge variant="outline">{sourceLabel(trigger.source)}</Badge>{/if}
            {#if trigger.category && !matches.length}
              <Badge variant="destructive">{humanizeCategory(trigger.category)}</Badge>
            {/if}
          </div>

          {#each matches as m, i (i)}
            <div class="space-y-1">
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

          {#if !matches.length && noRecordedMatch}
            {#if recheck && recheck.wouldBlock}
              <div class="flex flex-wrap items-center gap-1">
                <Badge variant="destructive">Would block now</Badge>
                {#each recheckCats as cat (cat)}
                  <Badge variant="outline">{categoryName(cat)}</Badge>
                {/each}
              </div>
            {:else if recheck && recheckCats.length}
              <div class="space-y-1">
                <Badge variant="outline" class="border-amber-500/40 bg-amber-500/10 text-amber-300">
                  Would not block now
                </Badge>
                <p class="m-0 text-xs text-dark-2">
                  Only terms that don't block on their own. Likely a warning, not a block.
                </p>
              </div>
            {:else if recheck}
              <p class="m-0 text-xs text-dark-0">No match with the current word list</p>
            {:else if awaitingRecheck}
              <p class="m-0 text-xs text-dark-2">
                {recheckStatus === 'failed' ? 'Match not recorded; re-check failed.' : 'Re-checking…'}
              </p>
            {:else}
              <p class="m-0 text-xs text-dark-2">Match not recorded at block time.</p>
            {/if}
          {/if}

          {#if testerLink}
            <a
              href={testerLink.href}
              title={testerLink.prefilled ? undefined : 'Prompt too long to prefill'}
              target="_blank"
              rel="noreferrer"
              class="text-xs {LINK_CLASS}"
            >
              Open in prompt tester ↗
            </a>
            {#if !testerLink.prefilled}
              <span class="text-xs text-dark-2">(too long to prefill)</span>
            {/if}
          {/if}
        </div>

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

      <div class="min-w-0 space-y-2">
        {#if trigger.reason}
          <div>
            <p class="mb-1 text-xs font-semibold tracking-wide text-dark-2 uppercase">Verdict</p>
            <p class="m-0 text-sm text-dark-0">{trigger.reason}</p>
          </div>
        {/if}
        {#if trigger.text}
          <div>
            <p class="mb-1 text-xs font-semibold tracking-wide text-dark-2 uppercase">
              Scanned text
            </p>
            <div class="max-h-48 overflow-auto rounded-md border border-dark-4 bg-dark-7 p-2">
              <p class="m-0 text-sm break-words whitespace-pre-wrap text-dark-0">{trigger.text}</p>
            </div>
          </div>
        {/if}
        {#if trigger.prompt}
          {@render textBox(
            'Prompt',
            trigger.prompt,
            recheck?.prompt,
            highlights.prompt,
            promptOriginal,
            () => (promptOriginal = !promptOriginal),
            'max-h-[32rem]'
          )}
        {/if}
        {#if trigger.negativePrompt}
          {@render textBox(
            'Negative',
            trigger.negativePrompt,
            recheck?.negativePrompt,
            highlights.negativePrompt,
            negativeOriginal,
            () => (negativeOriginal = !negativeOriginal),
            'max-h-48'
          )}
        {/if}

        {#if trigger.inputImages?.length || trigger.inputVideo}
          <div>
            <p class="mb-1 text-xs font-semibold tracking-wide text-dark-2 uppercase">
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
          </div>
        {/if}
      </div>
    </div>
  </div>
</section>

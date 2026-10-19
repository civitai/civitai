<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
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
  import type {
    RemixSource,
    RestrictionTriggerView,
  } from '$lib/server/user-restriction.service';
  import HighlightedText from './HighlightedText.svelte';
  import PromptDiff from './PromptDiff.svelte';

  let {
    trigger,
    index,
    total,
    civitaiUrl,
    source,
    sourceState,
    selected,
    onToggle,
  }: {
    trigger: RestrictionTriggerView;
    index: number;
    total: number;
    civitaiUrl: string;
    source: RemixSource | undefined;
    sourceState: SourceState | undefined;
    selected: boolean;
    onToggle: (key: string) => void;
  } = $props();

  const origin = $derived(triggerOrigin(trigger));
  const matches = $derived(explainMatches(trigger));
  const highlights = $derived(highlightSets(matches));
  const testerLink = $derived(
    trigger.prompt
      ? promptTesterHref({ prompt: trigger.prompt, negativePrompt: trigger.negativePrompt })
      : null
  );
  const noRecordedMatch = $derived(hasNoRecordedMatch(trigger));
  const isRemix = $derived(origin.kind === 'remix' || origin.kind === 'legacy-remix');
  const canDiff = $derived(isRemix && !!source?.prompt && !!trigger.prompt);
  // A diff is only offered when the match was not already settled as identical.
  const showDiff = $derived(canDiff && origin.match !== 'identical');
  const compared = $derived(origin.match === 'edited' || origin.match === 'unrelated');
  // Keyed by source so a failure never carries over to a different source.
  let failedSourceId = $state<number | null>(null);
  const imageFailed = $derived(source !== undefined && failedSourceId === source.id);
</script>

<TriageCard title="Trigger {index + 1} of {total}">
  <div class="space-y-4">
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
              bind:checked={() => selected, () => onToggle(trigger.key)}
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
        {:else if noRecordedMatch && testerLink}
          <p class="m-0 text-xs text-dark-2">
            Match not recorded.
            <a
              href={testerLink.href}
              title={testerLink.prefilled ? undefined : 'Prompt too long to prefill'}
              target="_blank"
              rel="noreferrer"
              class={LINK_CLASS}
            >
              Re-run in the prompt tester ↗
            </a>
            {#if !testerLink.prefilled}
              <span>(prompt too long to prefill)</span>
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

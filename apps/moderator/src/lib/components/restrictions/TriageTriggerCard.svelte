<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import PromptSegments from '$lib/components/PromptSegments.svelte';
  import { IconChevronDown } from '@tabler/icons-svelte';
  import type { ComponentProps, Snippet } from 'svelte';
  import { clipboardFeedback } from '$lib/clipboard.svelte';
  import { LINK_CLASS, dateTime, utcMs } from '$lib/format';
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
  import {
    cutSegments,
    foldPrompt,
    keepThroughFor,
    lastSegmentEnd,
    type FoldBox,
  } from '$lib/restrictions/prompt-fold';
  import { attemptTimes, formatSpan, repeatSpanMs } from '$lib/restrictions/trigger-groups';
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
  const noRecordedMatch = $derived(hasNoRecordedMatch(trigger));
  const testerLink = $derived(
    trigger.prompt && noRecordedMatch
      ? promptTesterHref({ prompt: trigger.prompt, negativePrompt: trigger.negativePrompt })
      : null
  );
  const attempts = $derived(attemptTimes(repeats));
  // Retries land seconds apart, so the minute-precision dateTime would show them all as equal.
  const timeWithSeconds = (time: string) =>
    new Date(utcMs(time)).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
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
  // Keyed per tile (by its media identity) so a failure never carries over to a different tile.
  let failedTiles = $state<Record<string, boolean>>({});
  // Prompts reach the 6,000-character cap; past the threshold only the start shows until expanded.
  const FOLD = { threshold: 2500, head: 1100 };
  let expanded = $state<Record<string, boolean>>({});
  const clipboard = clipboardFeedback();
  // Keyed on content; the suffix only separates identical matches.
  const matchRows = $derived.by(() => {
    const seen = new Map<string, number>();
    return matches.map((m) => {
      const base = `${m.field}:${m.category}:${m.text ?? m.regex}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { m, key: n ? `${base}#${n}` : base };
    });
  });
  const scannedHighlight = $derived([
    ...new Set(matches.flatMap((m) => [m.text, m.gateWord]).filter((t): t is string => !!t)),
  ]);
</script>

{#snippet whyBlocked()}
  {#if trigger.source}<Badge variant="outline">{sourceLabel(trigger.source)}</Badge>{/if}
  {#if trigger.category && !matches.length}
    <Badge variant="destructive">{humanizeCategory(trigger.category)}</Badge>
  {/if}

  {#each matchRows as { m, key } (key)}
    {#if m.category}
      <Badge variant="destructive">{humanizeCategory(m.category)}</Badge>
    {/if}
    {#if m.text}
      <span class="text-xs normal-case tracking-normal text-dark-0">
        <code class="break-all">"{m.text}"</code>
        {m.field ? `in ${fieldLabel(m.field)}` : ''}
        {#if isMissingFromText(m, trigger)}
          <span class="text-dark-2">(not found in text)</span>
        {/if}
      </span>
    {/if}
    {#if m.gateWord}
      <span class="text-xs normal-case tracking-normal text-dark-2">
        with NSFW term <code class="break-all text-dark-0">"{m.gateWord}"</code>
      </span>
    {/if}
    {#if m.regex}
      <details class="normal-case tracking-normal">
        <summary class="cursor-pointer text-xs text-dark-2">Pattern</summary>
        <code class="text-xs break-all text-dark-0">{m.regex}</code>
      </details>
    {/if}
  {/each}

  {#if !matches.length && noRecordedMatch}
    {#if recheck && recheck.wouldBlock}
      <Badge variant="destructive">Would block now</Badge>
      {#each recheckCats as cat (cat)}
        <Badge variant="outline">{categoryName(cat)}</Badge>
      {/each}
    {:else if recheck && recheckCats.length}
      <Badge variant="outline" class="border-amber-500/40 bg-amber-500/10 text-amber-300">
        Would not block now
      </Badge>
      <span class="text-xs normal-case tracking-normal text-dark-2">
        Only terms that don't block on their own. Likely a warning, not a block.
      </span>
    {:else if recheck}
      <span class="text-xs normal-case tracking-normal text-dark-0">
        No match with the current word list
      </span>
    {:else if awaitingRecheck}
      <span class="text-xs normal-case tracking-normal text-dark-2">
        {recheckStatus === 'failed' ? 'Match not recorded; re-check failed.' : 'Re-checking…'}
      </span>
    {:else}
      <span class="text-xs normal-case tracking-normal text-dark-2">
        Match not recorded at block time.
      </span>
    {/if}
  {/if}
{/snippet}

{#snippet promptTesterLink()}
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
      <span class="text-dark-2">(too long to prefill)</span>
    {/if}
  {/if}
{/snippet}

{#snippet textBox(b: {
  key: string;
  box: FoldBox;
  label: string;
  raw: string;
  segments?: RecheckResult['prompt'] | null;
  highlight: string[];
  original: boolean;
  toggle: () => void;
  evidence?: Snippet;
  extra?: Snippet;
})}
  {@const showSegments = !!b.segments && !b.original}
  {@const differs = !!b.segments && normalisedDiffers(b.segments, b.raw)}
  {@const legend = showSegments ? legendFor(b.segments!) : []}
  {@const shown = showSegments ? b.segments!.map((s) => s.text).join('') : b.raw}
  {@const fold = foldPrompt(shown, {
    ...FOLD,
    keepThrough: showSegments ? lastSegmentEnd(b.segments!) : keepThroughFor(shown, b.box, matches),
  })}
  {@const collapsed = fold.folded && !expanded[b.key]}
  <div class="rounded-md border border-dark-4 bg-dark-8">
    <div
      class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-dark-4 px-3 py-1.5 text-xs font-semibold text-dark-2"
    >
      <span class="tracking-wide uppercase">{b.label}</span>
      {#if b.evidence}{@render b.evidence()}{/if}
    </div>
    <div class="px-3 py-2 text-dark-0">
      {#if showSegments}
        <PromptSegments segments={collapsed ? cutSegments(b.segments!, fold.head.length) : b.segments!} />
      {:else}
        <HighlightedText text={collapsed ? fold.head : shown} highlight={b.highlight} />
      {/if}
      {#if collapsed}
        <p class="m-0 mt-1 text-xs text-dark-2">
          …
          <button
            type="button"
            class="cursor-pointer {LINK_CLASS}"
            onclick={() => (expanded[b.key] = true)}
          >
            Show all {fold.total.toLocaleString()} characters
          </button>
        </p>
      {:else if fold.folded}
        <button
          type="button"
          class="mt-1 cursor-pointer text-xs {LINK_CLASS}"
          onclick={() => (expanded[b.key] = false)}
        >
          Collapse
        </button>
      {/if}
      {#if legend.length}
        <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dark-2">
          {#each legend as l (l.cat)}
            <span class="inline-flex items-center gap-1">
              <span class="inline-block size-3 rounded {HIGHLIGHT_MARK[l.cat]}"></span>
              {l.label}
            </span>
          {/each}
        </div>
      {/if}
    </div>
    <div
      class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-dark-4 px-3 py-1.5 text-xs text-dark-2"
    >
      <span class="tabular-nums">{shown.length.toLocaleString()} characters</span>
      {#if b.segments}
        <span
          class="italic"
          title={showSegments
            ? 'Not recorded at block time; highlighted with the current word list'
            : 'The prompt as submitted'}
        >
          {showSegments ? 're-checked' : 'original'}
        </span>
        {#if differs}
          <button type="button" class="cursor-pointer {LINK_CLASS}" onclick={b.toggle}>
            {b.original ? 'show re-checked' : 'show original'}
          </button>
        {/if}
      {/if}
      {#if b.extra}{@render b.extra()}{/if}
      <button
        type="button"
        class="ml-auto cursor-pointer {LINK_CLASS}"
        onclick={() => clipboard.copy(b.raw, b.key)}
      >
        {clipboard.copied(b.key) ? 'Copied' : clipboard.failed(b.key) ? 'Copy failed' : 'Copy'}
      </button>
    </div>
  </div>
{/snippet}

{#snippet evidenceTile(t: {
  key: string;
  href: string;
  label: string;
  ariaLabel?: string;
  kind: 'source' | 'image' | 'video';
  src: string;
  alt?: string;
  mediaType?: ComponentProps<typeof EdgeMedia>['type'];
  nsfwLevel?: number;
})}
  <a
    href={t.href}
    target="_blank"
    rel="noreferrer"
    aria-label={t.ariaLabel}
    class="relative block aspect-[4/5] overflow-hidden rounded-lg border border-dark-4 bg-dark-6"
    onerrorcapture={() => (failedTiles[t.key] = true)}
  >
    {#if failedTiles[t.key]}
      <span class="flex size-full items-center justify-center p-2 text-center text-xs text-dark-2">
        {t.kind === 'video' ? 'Video unavailable' : 'Image unavailable'}
      </span>
    {:else if t.kind === 'source'}
      <EdgeMedia src={t.src} type={t.mediaType} width={450} class="size-full object-cover object-top" />
    {:else if t.kind === 'image'}
      <img src={t.src} alt={t.alt} loading="lazy" class="size-full object-cover object-top" />
    {:else}
      <video src={t.src} muted preload="metadata" class="size-full object-cover object-top"></video>
    {/if}
    {@render mediaTile(t.label)}
    {#if t.nsfwLevel !== undefined}
      <Badge variant="secondary" class="absolute bottom-2 left-2">
        {getBrowsingLevelLabel(t.nsfwLevel)}
      </Badge>
    {/if}
  </a>
{/snippet}

{#snippet mediaTile(label: string)}
  <span class="absolute top-2 left-2 rounded bg-black/60 px-1.5 py-px text-[10px] font-semibold text-white">
    {label}
  </span>
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
          class="inline-flex cursor-pointer items-center gap-1 rounded-full border border-dark-4 bg-dark-6 px-2 py-0.5 text-xs text-dark-0 transition-colors hover:border-dark-3 hover:bg-dark-5"
          aria-expanded={timesOpen}
          title="Identical prompt and input, retried"
          onclick={() => (timesOpen = !timesOpen)}
        >
          {count}×{span !== null ? ` in ${formatSpan(span)}` : ''}
          <span class="text-dark-2">· {timesOpen ? 'hide' : 'show'} times</span>
          <IconChevronDown
            size={14}
            class="text-dark-2 transition-transform {timesOpen ? 'rotate-180' : ''}"
          />
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
      {#if trigger.category !== 'scam'}
        <div class="flex items-center gap-2 {trigger.time ? 'ml-3' : 'ml-auto'}">
          <Checkbox
            id="flag-{trigger.key}"
            bind:checked={() => selected, () => onToggle(repeats.map((r) => r.key))}
          />
          <Label for="flag-{trigger.key}" class="font-normal text-dark-0">False positive</Label>
        </div>
      {/if}
    </header>

    {#if timesOpen}
      <div
        class="grid w-fit grid-cols-[auto_auto_auto] gap-x-4 gap-y-1 rounded-md bg-dark-6 px-3 py-2 text-xs"
      >
        {#each attempts as a, i (a.key)}
          <span class="text-dark-2">Attempt {i + 1}</span>
          <span class="tabular-nums text-dark-0">{a.time ? timeWithSeconds(a.time) : 'Time not recorded'}</span>
          <span class="tabular-nums text-dark-2">
            {i === 0 ? 'first' : a.offset !== null ? `+${formatSpan(a.offset)}` : ''}
          </span>
        {/each}
      </div>
    {/if}

    {#if origin.incomplete && origin.kind !== 'incomplete'}
      <p class="m-0 text-sm text-amber-300">
        Origin lookup incomplete; the evidence shown may be partial.
      </p>
    {/if}

    {#if trigger.prompt}
      {@render textBox({
        key: 'prompt',
        box: 'prompt',
        label: 'Prompt',
        raw: trigger.prompt,
        segments: recheck?.prompt,
        highlight: highlights.prompt,
        original: promptOriginal,
        toggle: () => (promptOriginal = !promptOriginal),
        evidence: whyBlocked,
        extra: promptTesterLink,
      })}
    {:else}
      <div class="flex flex-wrap items-center gap-2 text-xs text-dark-2">
        {@render whyBlocked()}
        {@render promptTesterLink()}
      </div>
      {#if !trigger.text}
        <p class="m-0 text-xs text-dark-2">No prompt recorded</p>
      {/if}
    {/if}

    {#if trigger.negativePrompt}
      {@render textBox({
        key: 'negative',
        box: 'negativePrompt',
        label: 'Negative',
        raw: trigger.negativePrompt,
        segments: recheck?.negativePrompt,
        highlight: highlights.negativePrompt,
        original: negativeOriginal,
        toggle: () => (negativeOriginal = !negativeOriginal),
      })}
    {/if}

    {#if trigger.reason}
      <div>
        <p class="mb-1 text-xs font-semibold tracking-wide text-dark-2 uppercase">Verdict</p>
        <p class="m-0 text-sm text-dark-0">{trigger.reason}</p>
      </div>
    {/if}
    {#if trigger.text}
      {@render textBox({
        key: 'scanned',
        box: 'text',
        label: 'Scanned text',
        raw: trigger.text,
        highlight: scannedHighlight,
        original: false,
        toggle: () => {},
      })}
    {/if}

    {#if (isRemix && origin.imageId) || trigger.inputImages?.length || trigger.inputVideo}
      {#if (isRemix && origin.imageId && source) || trigger.inputImages?.length || trigger.inputVideo}
        <div class="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          {#if isRemix && origin.imageId && source}
            {@render evidenceTile({
              key: `source:${source.id}`,
              href: `${civitaiUrl}/images/${source.id}`,
              label: 'Source',
              ariaLabel: 'Open the source image in a new tab',
              kind: 'source',
              src: source.url,
              mediaType: source.type,
              nsfwLevel: source.nsfwLevel,
            })}
          {/if}
          {#each trigger.inputImages ?? [] as url, i (`${i}:${url}`)}
            {@render evidenceTile({
              key: `image:${i}:${url}`,
              href: url,
              label: 'Input',
              kind: 'image',
              src: url,
              alt: `Input image ${i + 1}`,
            })}
          {/each}
          {#if trigger.inputVideo}
            {@render evidenceTile({
              key: `video:${trigger.inputVideo}`,
              href: trigger.inputVideo,
              label: 'Input video',
              ariaLabel: 'Open the input video in a new tab',
              kind: 'video',
              src: trigger.inputVideo,
            })}
          {/if}
        </div>
      {/if}
      {#if isRemix && origin.imageId}
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
      {/if}
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

    {#if trigger.entityType || trigger.cleanup}
      <p class="m-0 text-xs text-dark-2">
        {#if trigger.entityType}
          Entity <span class="text-dark-0">{trigger.entityType} #{trigger.entityId}</span>
        {/if}
        {#if trigger.entityType && trigger.cleanup}·{/if}
        {#if trigger.cleanup}
          Hidden by the auto-mute
          <span class="text-dark-0">
            {trigger.cleanup.count} ({trigger.cleanup.kind}){trigger.cleanup.truncated
              ? ', ids truncated'
              : ''}
          </span>
        {/if}
      </p>
    {/if}
  </div>
</section>

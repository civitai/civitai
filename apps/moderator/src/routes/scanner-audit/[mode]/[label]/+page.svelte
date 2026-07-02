<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { SvelteMap } from 'svelte/reactivity';
  import { IconCode, IconX, IconCopy, IconCheck, IconZoomIn, IconZoomOut } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@civitai/ui/components/ui/sheet/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { verdictFromAnswer, type ScanContent } from '$lib/scanner-audit';
  import { computeHighlightSegments, HIGHLIGHT_STYLES, getScannerLabelPolicy } from '@civitai/mod-utils';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const items = $derived(data.items);
  const base = $derived(page.url.pathname);

  let cursor = $state(0);
  $effect(() => {
    data.items; // reset when a new run loads (filter/lookback change)
    cursor = 0;
  });

  const current = $derived(items[cursor]);
  const done = $derived(items.length === 0 || cursor >= items.length);

  // Content cache (resolved lazily per item + prefetch a few ahead).
  const contentCache = new SvelteMap<string, ScanContent>();
  const inflight = new Set<string>();

  function contentParams(it: (typeof items)[number]): string {
    const p = new URLSearchParams({
      contentHash: it.contentHash,
      workflowId: it.workflowIds[0] ?? '',
      scanner: it.scanner,
    });
    for (const e of it.entityIds) p.append('entityId', e);
    return p.toString();
  }

  async function ensureContent(it: (typeof items)[number] | undefined) {
    if (!it || contentCache.has(it.contentHash) || inflight.has(it.contentHash)) return;
    inflight.add(it.contentHash);
    try {
      const res = await fetch(`${base}/content?${contentParams(it)}`);
      if (res.ok) contentCache.set(it.contentHash, await res.json());
    } finally {
      inflight.delete(it.contentHash);
    }
  }

  $effect(() => {
    cursor;
    for (let i = 0; i <= 4; i++) ensureContent(items[cursor + i]);
  });

  const currentContent = $derived(current ? (contentCache.get(current.contentHash) ?? null) : null);

  async function submitAnswer(shouldTrigger: boolean) {
    const item = current;
    if (!item) return;
    const verdict = verdictFromAnswer(item.triggered === 1, shouldTrigger);
    const content = contentCache.get(item.contentHash);
    const body =
      content && !content.unavailable
        ? {
            text: content.text,
            positivePrompt: content.positivePrompt,
            negativePrompt: content.negativePrompt,
            imageId: content.imageId,
            labelReasons: content.labelReasons,
            userId: content.userId,
          }
        : undefined;
    cursor = Math.min(cursor + 1, items.length); // optimistic advance
    try {
      await fetch(`${base}/verdict`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contentHash: item.contentHash,
          version: item.version,
          label: item.label,
          verdict,
          scanner: item.scanner,
          content: body,
        }),
      });
    } catch {
      /* optimistic — a failed verdict just won't be recorded; mod can revisit */
    }
  }

  const skip = () => (cursor = Math.min(cursor + 1, items.length));
  const back = () => (cursor = Math.max(cursor - 1, 0));

  $effect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (done) return;
      if (e.key === 'ArrowLeft') (e.preventDefault(), submitAnswer(false));
      else if (e.key === 'ArrowRight') (e.preventDefault(), submitAnswer(true));
      else if (e.key === 'ArrowDown') (e.preventDefault(), skip());
      else if (e.key === 'ArrowUp') (e.preventDefault(), back());
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  // Raw workflow drawer.
  let rawOpen = $state(false);
  let rawJson = $state<unknown>(undefined);
  let rawLoading = $state(false);
  async function openRaw(workflowId: string) {
    rawOpen = true;
    rawLoading = true;
    rawJson = undefined;
    try {
      const res = await fetch(`${base}/workflow?workflowId=${encodeURIComponent(workflowId)}`);
      rawJson = res.ok ? await res.json() : null;
    } finally {
      rawLoading = false;
    }
  }

  const tablePath = $derived(`/scanner-audit/${data.mode}`);
  const scannerShort = $derived(data.scanner.replace('xguard_', '').replace('image_ingestion', 'image'));
  const policy = $derived(getScannerLabelPolicy(data.label));

  const MIN_FONT = 12;
  const MAX_FONT = 24;
  let fontSize = $state(16);
  const zoomOut = () => (fontSize = Math.max(fontSize - 2, MIN_FONT));
  const zoomIn = () => (fontSize = Math.min(fontSize + 2, MAX_FONT));

  let copiedId = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyWorkflowId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      copiedId = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copiedId = false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  const hasMatched = $derived(
    !!current &&
      current.matchedText.length +
        current.matchedPositivePrompt.length +
        current.matchedNegativePrompt.length >
        0
  );
</script>

{#snippet highlighted(text: string, terms: string[], label: string)}{#each computeHighlightSegments(text, terms, label) as seg}{#if seg.source}<mark
        class="rounded px-1"
        style="background:{HIGHLIGHT_STYLES[seg.source].bg};color:#111827;font-weight:{HIGHLIGHT_STYLES[
          seg.source
        ].weight}"
        title={HIGHLIGHT_STYLES[seg.source].title}>{seg.text}</mark>{:else}{seg.text}{/if}{/each}{/snippet}

{#snippet policySection(heading: string, colorClass: string, items: string[])}
  {#if items.length > 0}
    <div>
      <div class="mb-1 text-xs font-semibold uppercase {colorClass}">{heading}</div>
      <ul class="list-disc space-y-1 pl-5 text-sm">
        {#each items as item}<li>{item}</li>{/each}
      </ul>
    </div>
  {/if}
{/snippet}

{#snippet matchedTerms(label: string, terms: string[])}
  {#if terms.length > 0}
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="text-xs font-medium text-muted-foreground">{label}:</span>
      {#each terms as t}
        <Badge variant="outline" class="border-orange-400/40 bg-orange-400/10 font-normal text-orange-300"
          >{t}</Badge
        >
      {/each}
    </div>
  {/if}
{/snippet}

<!-- Full-bleed panel (layout drops its max-w wrapper via fullBleed): scrolling content column with a
     pinned footer on the left, full-height policy sidebar flush to the right. h-12 = the layout header. -->
<div class="flex h-[calc(100svh-3rem)]">
  <div class="flex min-w-0 flex-1 flex-col">
    <div class="flex-1 overflow-y-auto px-6 py-4">
    <div class="mx-auto flex max-w-3xl flex-col gap-4">
      <div class="flex items-start justify-between gap-2">
    <div class="flex flex-col gap-1">
      <div class="flex items-center gap-2">
        <span class="text-xs uppercase text-muted-foreground">Label</span>
        <Badge variant="secondary">{scannerShort}</Badge>
      </div>
      <h1 class="font-mono text-3xl">{data.label}</h1>
    </div>
    <Button variant="outline" size="sm" href={tablePath}><IconX size={14} /> Back to table</Button>
  </div>

  {#if done}
    <div class="rounded-xl border p-6">
      <h2 class="text-xl font-semibold">Run complete</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        {items.length === 0
          ? `No unverdicted scans for ${data.label} in the current lookback window.`
          : `You reviewed ${cursor} of ${items.length} scans for ${data.label}.`}
        {#if data.verdictedInLookback > 0}
          (You've verdicted {data.verdictedInLookback.toLocaleString()} {data.label} scan{data
            .verdictedInLookback === 1
            ? ''
            : 's'} in the last {data.lookbackDays} days.)
        {/if}
      </p>
      <div class="mt-4 flex flex-col gap-2">
        <Button variant="outline" href={tablePath}>Back to table</Button>
        <Button onclick={() => goto(`${base}?lookbackDays=${(data.lookbackDays ?? 30) + 30}`)}>
          Grab more (extend lookback by 30 days)
        </Button>
      </div>
    </div>
  {:else if current}
    {@const c = currentContent}
    <div class="flex flex-col gap-3">
      <!-- header meta -->
      <div class="flex flex-wrap items-center gap-2">
        {#if c?.userId}
          <Badge class="bg-blue-500/15 text-blue-300">user {c.userId}</Badge>
        {/if}
        {#if current.labelValue}<Badge variant="outline">value: {current.labelValue}</Badge>{/if}
        <Badge variant="outline">{current.occurrences.toLocaleString()} occurrences</Badge>
        {#if current.workflowIds[0]}
          <Button variant="outline" size="sm" onclick={() => copyWorkflowId(current.workflowIds[0])}>
            {#if copiedId}<IconCheck size={14} />{:else}<IconCopy size={14} />{/if}
            {copiedId ? 'Copied' : 'Copy ID'}
          </Button>
          <Button variant="outline" size="sm" onclick={() => openRaw(current.workflowIds[0])}>
            <IconCode size={14} /> Raw workflow
          </Button>
        {/if}
        <div class="ml-auto flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            class="size-8"
            title="Smaller text"
            onclick={zoomOut}
            disabled={fontSize <= MIN_FONT}
          >
            <IconZoomOut size={14} />
          </Button>
          <Button
            variant="outline"
            size="icon"
            class="size-8"
            title="Larger text"
            onclick={zoomIn}
            disabled={fontSize >= MAX_FONT}
          >
            <IconZoomIn size={14} />
          </Button>
        </div>
      </div>

      <div class="h-1 w-full overflow-hidden rounded bg-muted">
        <div
          class="h-full bg-primary transition-all"
          style="width:{(cursor / Math.max(items.length, 1)) * 100}%"
        ></div>
      </div>

      {#if c?.labelReasons?.[current.label]}
        <p class="text-sm italic text-muted-foreground">{c.labelReasons[current.label]}</p>
      {/if}

      <!-- trigger banner -->
      <div class="flex items-center gap-2">
        <Badge class={current.triggered === 1 ? 'bg-red-500/20 text-red-300' : 'bg-muted'}>
          {current.triggered === 1 ? 'TRIGGERED' : 'NOT TRIGGERED'}
        </Badge>
        <span class="text-sm text-muted-foreground">
          score {current.score.toFixed(3)}{current.threshold !== null
            ? ` / threshold ${current.threshold.toFixed(2)}`
            : ''}
        </span>
      </div>

      {#if hasMatched}
        <div class="flex flex-col gap-1.5">
          {@render matchedTerms('Matched', current.matchedText)}
          {@render matchedTerms('Matched (positive)', current.matchedPositivePrompt)}
          {@render matchedTerms('Matched (negative)', current.matchedNegativePrompt)}
        </div>
      {/if}

      <!-- content -->
      {#if !c}
        <div class="rounded-lg border p-6 text-center text-sm text-muted-foreground">Loading content…</div>
      {:else if c.unavailable}
        <div class="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-300">
          Content unavailable — you can still record a verdict.
          {#if c.unavailableReason}<div class="mt-1 font-mono text-xs opacity-70">{c.unavailableReason}</div>{/if}
        </div>
      {:else if current.scanner === 'image_ingestion' && c.imageUrl}
        <div class="flex justify-center rounded-lg border p-3">
          <img src={c.imageUrl} alt={`image ${c.imageId}`} class="max-h-[500px] object-contain" />
        </div>
      {:else if current.scanner === 'xguard_text'}
        <div
          class="whitespace-pre-wrap rounded-lg border p-4 leading-relaxed"
          style="font-size:{fontSize}px"
        >
          {@render highlighted(c.text ?? '', current.matchedText, current.label)}
        </div>
      {:else}
        <div class="rounded-lg border p-4">
          <div class="mb-1 text-xs uppercase text-muted-foreground">Positive prompt</div>
          <div class="whitespace-pre-wrap leading-relaxed" style="font-size:{fontSize}px">
            {@render highlighted(c.positivePrompt ?? '', current.matchedPositivePrompt, current.label)}
          </div>
        </div>
        {#if c.negativePrompt}
          <div class="rounded-lg border p-4">
            <div class="mb-1 text-xs uppercase text-muted-foreground">Negative prompt</div>
            <div class="whitespace-pre-wrap leading-relaxed" style="font-size:{fontSize}px">
              {@render highlighted(c.negativePrompt, current.matchedNegativePrompt, current.label)}
            </div>
          </div>
        {/if}
      {/if}

      </div>
      {/if}
    </div>
  </div>

  {#if current && !done}
    <div class="shrink-0 border-t bg-background px-6 py-3">
      <div class="mx-auto flex max-w-3xl items-center justify-center gap-2">
        <Button variant="destructive" class="w-48" onclick={() => submitAnswer(false)}>← No</Button>
        <Button variant="outline" onclick={back} disabled={cursor === 0}>↑ Back</Button>
        <Button variant="outline" onclick={skip}>↓ Skip</Button>
        <Button class="w-48 bg-teal-600 hover:bg-teal-600" onclick={() => submitAnswer(true)}>Yes →</Button>
      </div>
      <p class="mx-auto mt-1 max-w-3xl text-center text-xs text-muted-foreground">
        {cursor + 1} of {items.length} · ← No · → Yes · ↓ Skip · ↑ Back — Yes/No map to TP/FP/TN/FN
      </p>
    </div>
    {/if}
  </div>

  {#if current && !done}
    <aside class="hidden w-[26rem] shrink-0 overflow-y-auto border-l bg-muted/20 px-4 py-4 lg:block">
      {#if !policy}
        <h2 class="font-mono text-lg">{data.label}</h2>
        <p class="mt-2 rounded-md border p-3 text-sm text-muted-foreground">
          No moderator policy summary on file for this label yet.
        </p>
      {:else}
        <div class="flex flex-col gap-4">
          <div>
            <div class="text-xs font-medium uppercase text-muted-foreground">Policy</div>
            <h2 class="font-mono text-xl font-semibold">{policy.title}</h2>
          </div>
          <div>
            <span class="mb-1 inline-block rounded bg-blue-500/15 px-1.5 py-0.5 text-xs font-medium text-blue-300">Catch</span>
            <p class="text-sm">{policy.catch}</p>
          </div>
          {@render policySection('Should fire on', 'text-green-400', policy.shouldFire)}
          {@render policySection('Should NOT fire on', 'text-red-400', policy.shouldNotFire)}
          {@render policySection('Gotchas', 'text-yellow-400', policy.gotchas ?? [])}
          <p class="text-xs text-muted-foreground">
            Only the <strong>positive prompt</strong> decides the verdict — terms appearing only in the
            negative prompt are avoidance signals.
          </p>
        </div>
      {/if}
    </aside>
  {/if}
</div>

<Sheet bind:open={rawOpen}>
  <SheetContent side="right" class="w-[92vw] overflow-y-auto sm:max-w-[84rem]">
    <SheetHeader><SheetTitle>Raw workflow</SheetTitle></SheetHeader>
    <div class="p-4">
      {#if rawLoading}
        <p class="text-sm text-muted-foreground">Loading…</p>
      {:else if rawJson === null || rawJson === undefined}
        <div class="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-300">
          Workflow not found in orchestrator (may have expired past the 30-day retention window).
        </div>
      {:else}
        <pre class="overflow-auto rounded-md border bg-muted/40 p-3 text-xs">{JSON.stringify(rawJson, null, 2)}</pre>
      {/if}
    </div>
  </SheetContent>
</Sheet>

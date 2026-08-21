<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';
  import type { Span } from '$lib/server/xguard-lab';
  import { findTermSpans, TERM_STYLES } from '$lib/highlight-terms';

  let { data }: { data: PageData } = $props();

  let shownAt = $state(Date.now());
  let submitting = $state(false);
  let form = $state<HTMLFormElement>();
  let note = $state('');

  // Reset the timer whenever a new item lands, so duration_ms measures time on THIS item.
  // A reviewer averaging a couple of seconds is rubber-stamping, and that only shows up if
  // the number is honest.
  //
  // Guarded on the id rather than re-running on every `data` change: an unguarded effect would
  // wipe a half-typed note each time the page reloaded for an unrelated reason.
  let shownFor = $state<string | null>(null);
  $effect(() => {
    const id = data.item?.sampleId ?? null;
    if (shownFor === id) return;
    shownFor = id;
    shownAt = Date.now();
    note = data.existing?.note ?? '';
  });

  function queryFor(params: Record<string, string | null>): string {
    const q = new URLSearchParams();
    q.set('label', data.label);
    if (data.skipped.length) q.set('skip', data.skipped.join(','));
    for (const [k, v] of Object.entries(params)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    return `/xguard?${q.toString()}`;
  }

  const queueHref = $derived(queryFor({ sample: null }));
  const undoHref = $derived(
    data.lastReviewedSampleId ? queryFor({ sample: data.lastReviewedSampleId }) : null
  );

  type Piece = { text: string; className: string; cited: boolean };

  // Two independent sources of highlight, merged into one pass over the text:
  //
  //   term spans  - vocabulary we care about, colour-coded by kind. Always shown, so the reviewer
  //                 can see what the rater DIDN'T cite as easily as what it did.
  //   rater spans - the exact substrings the model said it judged on. Drawn as a ring on top of
  //                 whatever colour is underneath, so "the model saw this" and "this is a youth
  //                 term" are separate facts and either can be present without the other.
  //
  // A rater span with no term colour under it means the model reasoned off something not in our
  // lists - worth noticing. A red term with no ring means the model ignored a word we flag.
  function pieces(text: string, raterSpans: Span[] | undefined): Piece[] {
    if (!text) return [];

    const terms = findTermSpans(text, data.terms);
    const cited = (raterSpans ?? []).filter((s) => s.start < s.end);

    // Every offset where the styling could change.
    const cuts = new Set<number>([0, text.length]);
    for (const s of [...terms, ...cited]) {
      cuts.add(Math.max(0, s.start));
      cuts.add(Math.min(text.length, s.end));
    }
    const points = [...cuts].sort((a, b) => a - b);

    const out: Piece[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const [from, to] = [points[i], points[i + 1]];
      if (from >= to) continue;
      const term = terms.find((s) => s.start <= from && s.end >= to);
      const isCited = cited.some((s) => s.start <= from && s.end >= to);
      const className = term ? TERM_STYLES[term.kind].className : '';
      const piece = { text: text.slice(from, to), className, cited: isCited };
      // Merge into the previous run when nothing changed, so the DOM stays small on long prompts.
      const prev = out[out.length - 1];
      if (prev && prev.className === className && prev.cited === isCited) prev.text += piece.text;
      else out.push(piece);
    }
    return out;
  }

  const positivePieces = $derived(
    pieces(data.item?.positivePrompt ?? '', data.item?.highlights?.positive)
  );
  const negativePieces = $derived(
    pieces(data.item?.negativePrompt ?? '', data.item?.highlights?.negative)
  );

  // Set at click time and read in enhance's submit hook. Do NOT route these through hidden
  // inputs: Svelte 5 flushes DOM writes in a microtask while requestSubmit() dispatches submit
  // synchronously, so the form would carry the PREVIOUS click's answer. That inverted real
  // judgements before it was caught.
  let pendingAgreed = false;
  let pendingDuration = 0;

  function submit(agreed: boolean) {
    if (submitting || !data.item) return;
    pendingAgreed = agreed;
    pendingDuration = Date.now() - shownAt;
    submitting = true;
    form?.requestSubmit();
  }

  // A skip is deliberately not a verdict. Recording one would remove the item from the queue for
  // good; parking it in the URL means it comes back the next time the queue is opened fresh.
  function skip() {
    if (submitting || !data.item) return;
    const next = [...data.skipped.filter((id) => id !== data.item?.sampleId), data.item.sampleId];
    const q = new URLSearchParams({ label: data.label, skip: next.join(',') });
    void goto(`/xguard?${q.toString()}`);
  }

  function onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    // Ctrl+A is select-all and Ctrl/Cmd+D is bookmark. Without this, either one silently writes a
    // judgement to the ground-truth table.
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key === 'a') {
      e.preventDefault();
      submit(true);
    }
    if (e.key === 'd') {
      e.preventDefault();
      submit(false);
    }
    if (e.key === 's' && !data.pinned) {
      e.preventDefault();
      skip();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<header class="page-header">
  <h1>XGuard label lab</h1>
  <p>
    Agree or disagree with the rating. <kbd>A</kbd> agree, <kbd>D</kbd> disagree, <kbd>S</kbd> skip.
  </p>
</header>

<div class="mb-4 flex flex-wrap items-center gap-2">
  <a href="/xguard/labels" class="rounded bg-dark-7 px-2.5 py-1 text-xs text-dark-2 hover:text-dark-0">
    All labels
  </a>
  <a
    href="/xguard/runs?label={data.label}"
    class="rounded bg-dark-7 px-2.5 py-1 text-xs text-dark-2 hover:text-dark-0"
  >
    Runs
  </a>
  {#each data.labels as l (l.name)}
    <a
      href="/xguard?label={l.name}"
      class="rounded px-2.5 py-1 text-xs font-medium {l.name === data.label
        ? 'bg-blue-8/25 text-blue-3'
        : 'bg-dark-7 text-dark-2 hover:text-dark-0'}"
      title={l.description}
    >
      {l.name}
    </a>
  {/each}
  <span class="ml-auto text-xs text-dark-3">
    {data.progress.reviewed} reviewed of {data.progress.rated} rated
    {#if data.progress.reviewed > 0}
      &middot; disagreed on {Math.round((data.progress.disagreed / data.progress.reviewed) * 100)}%
    {/if}
  </span>
</div>

<!-- Confirmed positives, not total reviewed, is what decides whether recall can be measured at all.
     A reviewer can clear 200 items and still leave the label unevaluable. -->
<div class="mb-4 flex flex-wrap items-center gap-2 text-xs">
  <span
    class="rounded px-2.5 py-1 {data.progress.labelPositives === 0
      ? 'bg-red-8/20 text-red-3'
      : 'bg-green-8/20 text-green-3'}"
  >
    {data.progress.labelPositives} confirmed positive{data.progress.labelPositives === 1 ? '' : 's'}
    {#if data.progress.labelPositives === 0}
      &middot; recall stays unmeasurable until there is at least one
    {/if}
  </span>
  <span class="text-dark-3">{data.progress.myPositives} of them yours</span>
  {#if data.skipped.length}
    <a href={queryFor({ skip: null, sample: null })} class="text-blue-4 hover:text-blue-3">
      {data.skipped.length} skipped this session &middot; bring them back
    </a>
  {/if}
</div>

{#if data.pinned}
  <div class="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-dark-7 px-3 py-2 text-xs">
    <span class="text-dark-1">
      Revisiting one sample.
      {#if data.existing}
        You said <strong class="text-dark-0">{data.existing.agreed ? 'agree' : 'disagree'}</strong>
        &rarr; verdict <strong class="text-dark-0">{data.existing.verdict ? 'yes' : 'no'}</strong>.
      {:else}
        You have not judged this one yet.
      {/if}
    </span>
    <a href={queueHref} class="ml-auto text-blue-4 hover:text-blue-3">Back to the queue &rarr;</a>
  </div>
{/if}

{#if !data.item}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-8 text-center">
    <p class="text-sm text-dark-2">
      Nothing left to review for <strong class="text-dark-0">{data.label}</strong>.
    </p>
    {#if data.skipped.length}
      <a
        href={queryFor({ skip: null, sample: null })}
        class="mt-2 inline-block text-sm text-blue-4 hover:text-blue-3"
      >
        Except {data.skipped.length} you skipped &mdash; bring them back
      </a>
    {/if}
  </section>
{:else}
  <section class="grid gap-4 lg:grid-cols-[1fr_20rem]">
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <div class="mb-1.5 text-xs font-medium uppercase tracking-wider text-dark-2">Positive prompt</div>
      <p class="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-dark-0">
        {#each positivePieces as piece, i (i)}{#if piece.className || piece.cited}<mark
            class="rounded px-0.5 {piece.className} {piece.cited
              ? 'ring-1 ring-blue-4/70'
              : ''}">{piece.text}</mark
          >{:else}{piece.text}{/if}{/each}
      </p>

      <div class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-dark-5 pt-3 text-xs text-dark-3">
        {#each Object.entries(TERM_STYLES) as [kind, style] (kind)}
          <span class="inline-flex items-center gap-1.5">
            <span class="inline-block h-2.5 w-2.5 rounded-sm {style.className}"></span>{style.label}
          </span>
        {/each}
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-blue-4/70"></span>cited by the rater
        </span>
      </div>

      {#if data.item.negativePrompt}
        <div class="mt-4 mb-1.5 text-xs font-medium uppercase tracking-wider text-dark-2">
          Negative prompt <span class="normal-case text-dark-3">(excluded by the user)</span>
        </div>
        <p class="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-dark-2">
          {#each negativePieces as piece, i (i)}{#if piece.className || piece.cited}<mark
              class="rounded px-0.5 opacity-70 {piece.className} {piece.cited
                ? 'ring-1 ring-blue-4/70'
                : ''}">{piece.text}</mark
            >{:else}{piece.text}{/if}{/each}
        </p>
      {/if}
    </div>

    <div class="flex flex-col gap-4">
      <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-xs font-medium uppercase tracking-wider text-dark-2">Rating</span>
          <span class="text-xs text-dark-3">{data.item.model}</span>
        </div>
        <div
          class="mb-3 inline-block rounded px-2 py-1 text-sm font-semibold {data.item.aiVerdict
            ? 'bg-red-8/25 text-red-3'
            : 'bg-green-8/25 text-green-3'}"
        >
          {data.item.aiVerdict ? data.label : `not ${data.label}`}
        </div>
        <p class="text-sm leading-relaxed text-dark-1">{data.item.aiReason}</p>
      </div>

      {#if data.item.liveScores}
        <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
          <div class="mb-2 text-xs font-medium uppercase tracking-wider text-dark-2">
            Live XGuard at sample time
          </div>
          <div class="flex flex-col gap-1">
            {#each Object.entries(data.item.liveScores) as [name, score] (name)}
              <div class="flex justify-between text-sm">
                <span class="text-dark-2">{name}</span>
                <span class="font-mono text-dark-0">{score.toFixed(3)}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <form
        method="POST"
        action="?/judge"
        bind:this={form}
        use:enhance={({ formData }) => {
          formData.set('agreed', String(pendingAgreed));
          formData.set('durationMs', String(pendingDuration));
          const wasPinned = data.pinned;
          return async ({ update }) => {
            await update({ reset: false });
            // Revisiting is a one-item detour; land back on the queue rather than re-showing the
            // item that was just re-answered.
            if (wasPinned) await goto(queueHref, { invalidateAll: true });
            else await invalidateAll();
            submitting = false;
          };
        }}
      >
        <input type="hidden" name="sampleId" value={data.item.sampleId} />
        <input type="hidden" name="label" value={data.label} />
        <input type="hidden" name="judgementId" value={data.item.judgementId} />
        <input type="hidden" name="aiVerdict" value={String(data.item.aiVerdict)} />

        <label class="mb-3 flex flex-col gap-1">
          <span class="text-xs font-medium uppercase tracking-wider text-dark-2">
            Note <span class="normal-case text-dark-3">(optional)</span>
          </span>
          <textarea
            name="note"
            bind:value={note}
            rows="2"
            placeholder="why this one is not obvious"
            class="w-full rounded border border-dark-4 bg-dark-8 px-2 py-1.5 text-sm text-dark-0 focus:border-blue-6 focus:outline-none"
          ></textarea>
        </label>

        <div class="flex gap-2">
          <button
            type="button"
            disabled={submitting}
            onclick={() => submit(true)}
            class="flex-1 rounded-lg bg-green-8/25 px-3 py-2.5 text-sm font-semibold text-green-3 hover:bg-green-8/40 disabled:opacity-50"
          >
            Agree <kbd class="ml-1 text-xs opacity-60">A</kbd>
          </button>
          <button
            type="button"
            disabled={submitting}
            onclick={() => submit(false)}
            class="flex-1 rounded-lg bg-red-8/25 px-3 py-2.5 text-sm font-semibold text-red-3 hover:bg-red-8/40 disabled:opacity-50"
          >
            Disagree <kbd class="ml-1 text-xs opacity-60">D</kbd>
          </button>
        </div>
      </form>

      <div class="flex gap-2">
        {#if !data.pinned}
          <button
            type="button"
            disabled={submitting}
            onclick={skip}
            class="flex-1 rounded-lg bg-dark-7 px-3 py-2 text-sm text-dark-1 hover:text-dark-0 disabled:opacity-50"
          >
            Skip <kbd class="ml-1 text-xs opacity-60">S</kbd>
          </button>
          {#if undoHref}
            <a
              href={undoHref}
              class="flex-1 rounded-lg bg-dark-7 px-3 py-2 text-center text-sm text-dark-1 hover:text-dark-0"
            >
              Back one &amp; change it
            </a>
          {/if}
        {/if}
      </div>

      <p class="text-xs text-dark-3">
        Batch {data.item.batch}
      </p>
    </div>
  </section>
{/if}

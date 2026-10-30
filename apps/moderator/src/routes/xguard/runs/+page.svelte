<script lang="ts">
  import type { PageData } from './$types';
  import { findTermSpans, TERM_STYLES } from '$lib/highlight-terms';

  let { data }: { data: PageData } = $props();

  let expanded = $state(new Set<string>());

  // A new run means a new result list; keeping old ids expanded would open unrelated rows.
  let expandedFor = $state<string | null>(null);
  $effect(() => {
    const id = data.selected?.id ?? null;
    if (expandedFor === id) return;
    expandedFor = id;
    expanded = new Set();
  });

  function toggle(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  // Precision and recall are undefined, not zero, when the denominator is empty. Rendering 0.000
  // reads as "got everything wrong" for a run that simply had nothing to be right about.
  //
  // Recomputed from the counters rather than read off the columns: runs written before precision
  // and recall became nullable stored 0 for undefined, so the stored value cannot be trusted to
  // distinguish the two cases.
  type Counters = { tp: number; fp: number; fn: number };
  const precisionOf = (r: Counters) => (r.tp + r.fp === 0 ? null : r.tp / (r.tp + r.fp));
  const recallOf = (r: Counters) => (r.tp + r.fn === 0 ? null : r.tp / (r.tp + r.fn));
  const pct = (n: number | null) => (n === null ? 'n/a' : n.toFixed(3));

  const COLLAPSED_CHARS = 260;

  type Piece = { text: string; className: string };

  function pieces(text: string): Piece[] {
    if (!text) return [];
    const terms = findTermSpans(text, data.terms ?? []);
    const out: Piece[] = [];
    let at = 0;
    for (const s of terms) {
      if (s.start > at) out.push({ text: text.slice(at, s.start), className: '' });
      out.push({ text: text.slice(s.start, s.end), className: TERM_STYLES[s.kind].className });
      at = s.end;
    }
    if (at < text.length) out.push({ text: text.slice(at), className: '' });
    return out;
  }

  function truncate(list: Piece[], limit: number): Piece[] {
    const out: Piece[] = [];
    let used = 0;
    for (const p of list) {
      if (used >= limit) break;
      out.push({ ...p, text: p.text.slice(0, limit - used) });
      used += p.text.length;
    }
    out.push({ text: '…', className: '' });
    return out;
  }

  // Highlight each prompt once per result set, not once per render. `pieces` runs ~253 regexes plus
  // an overlap scan, and calling it inline in the template made a single "Show all" click re-run it
  // for all 250 rows. Nothing here reads `expanded`, so toggling only reselects an existing array.
  const rows = $derived(
    data.results.map((r) => {
      const full = pieces(r.positivePrompt);
      const long = r.positivePrompt.length > COLLAPSED_CHARS;
      return { ...r, full, head: long ? truncate(full, COLLAPSED_CHARS) : full, long };
    })
  );

  const BUCKET_STYLE: Record<string, string> = {
    TP: 'bg-green-8/25 text-green-3',
    FP: 'bg-red-8/25 text-red-3',
    TN: 'bg-dark-5 text-dark-1',
    FN: 'bg-red-8/25 text-red-3',
    error: 'bg-dark-5 text-dark-2',
  };

  const FILTERS = [
    { key: 'wrong', label: 'Mistakes (FP + FN)' },
    { key: 'FP', label: 'FP' },
    { key: 'FN', label: 'FN' },
    { key: 'TP', label: 'TP' },
    { key: 'TN', label: 'TN' },
    { key: 'error', label: 'Errors' },
    { key: 'all', label: 'All' },
  ];

  function href(params: Record<string, string | null>): string {
    const q = new URLSearchParams();
    if (data.label) q.set('label', data.label);
    if (data.selected) q.set('run', data.selected.id);
    if (data.bucketFilter !== 'wrong') q.set('bucket', data.bucketFilter);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    return `/xguard/runs?${q.toString()}`;
  }

  function countFor(key: string): number | null {
    const c = data.bucketCounts;
    if (key === 'wrong') return (c.FP ?? 0) + (c.FN ?? 0);
    if (key === 'all') return Object.values(c).reduce((a, b) => a + b, 0);
    return c[key] ?? 0;
  }
</script>

<header class="page-header">
  <h1>Evaluation runs</h1>
  <p>What a policy scored, and which prompts it got wrong.</p>
</header>

<div class="mb-4 flex flex-wrap items-center gap-2">
  <a href="/xguard/labels" class="rounded bg-dark-7 px-2.5 py-1 text-xs text-dark-2 hover:text-dark-0">
    All labels
  </a>
  <a
    href="/xguard/runs"
    class="rounded px-2.5 py-1 text-xs font-medium {data.label
      ? 'bg-dark-7 text-dark-2 hover:text-dark-0'
      : 'bg-blue-8/25 text-blue-3'}"
  >
    Every label
  </a>
  {#each data.labels as l (l.name)}
    <a
      href="/xguard/runs?label={l.name}"
      class="rounded px-2.5 py-1 text-xs font-medium {l.name === data.label
        ? 'bg-blue-8/25 text-blue-3'
        : 'bg-dark-7 text-dark-2 hover:text-dark-0'}"
    >
      {l.name}
    </a>
  {/each}
</div>

{#if data.missingRun}
  <div class="mb-4 rounded-lg bg-dark-7 px-3 py-2 text-sm text-dark-1">
    That run is not in this view{data.label ? ` — it may belong to a label other than ${data.label}` : ''}.
    {#if data.runs.length}Showing the newest one instead.{/if}
    <a href="/xguard/runs" class="ml-1 text-blue-4 hover:text-blue-3">Show every label</a>
  </div>
{/if}

{#if data.runs.length === 0}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-8 text-center text-sm text-dark-2">
    No evaluation runs yet{data.label ? ` for ${data.label}` : ''}. Run one from a label's policy page.
  </section>
{:else}
  <section class="grid gap-4 lg:grid-cols-[24rem_1fr] lg:items-start">
    <div class="flex flex-col gap-2 lg:max-h-[80vh] lg:overflow-y-auto">
      {#each data.runs as r (r.id)}
        {@const active = data.selected?.id === r.id}
        <a
          href={href({ run: r.id })}
          class="block rounded-xl border p-3.5 {active
            ? 'border-blue-6 bg-dark-6'
            : 'border-dark-4 bg-dark-6 hover:border-dark-3'}"
        >
          <div class="flex items-baseline gap-2">
            <span class="text-sm font-semibold text-dark-0">{r.label}</span>
            <span class="rounded bg-dark-7 px-1.5 py-0.5 text-xs text-dark-1">{r.policyLabel}</span>
            <span class="text-xs text-dark-3">@ {r.threshold}</span>
            {#if r.status !== 'complete'}
              <span class="ml-auto rounded bg-dark-5 px-1.5 py-0.5 text-xs text-dark-1">{r.status}</span>
            {/if}
          </div>

          <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs">
            <span class="text-green-3">TP {r.tp}</span>
            <span class="text-red-3">FP {r.fp}</span>
            <span class="text-dark-1">TN {r.tn}</span>
            <span class="text-red-3">FN {r.fn}</span>
            <span class="text-dark-0">P {pct(precisionOf(r))}</span>
            <span class="text-dark-0">R {pct(recallOf(r))}</span>
            {#if r.errors > 0}<span class="text-dark-2">err {r.errors}</span>{/if}
          </div>

          {#if r.note}
            <p class="mt-2 text-xs text-dark-2">{r.note}</p>
          {/if}

          <div class="mt-2 flex flex-wrap gap-x-2 text-xs text-dark-3">
            <span>{new Date(r.startedAt).toLocaleString()}</span>
            {#if r.batch}<span>&middot; batch {r.batch}</span>{/if}
          </div>
        </a>
      {/each}
    </div>

    {#if data.selected}
      {@const s = data.selected}
      <div class="flex flex-col gap-3">
        <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
          <div class="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 class="text-base font-semibold text-white">{s.label}</h2>
            <span class="rounded bg-dark-7 px-2 py-0.5 text-xs text-dark-1">{s.policyLabel}</span>
            <span class="text-xs text-dark-3">threshold {s.threshold}</span>
            <a href="/xguard/labels/{s.label}" class="ml-auto text-xs text-blue-4 hover:text-blue-3">
              Policy &rarr;
            </a>
          </div>

          <!-- Derived from the counters, not from `recall === null`: runs written before those
               columns became nullable stored 0 for an undefined recall, and trusting the column
               silently drops the warning on exactly those runs. -->
          {#if s.tp + s.fn === 0}
            <div class="mb-3 rounded-lg bg-red-8/15 px-3 py-2 text-sm text-red-3">
              No confirmed positives in scope, so recall is undefined - this run cannot tell you what the
              policy misses.
            </div>
          {/if}

          <div class="flex flex-wrap gap-2">
            {#each FILTERS as f (f.key)}
              <a
                href={href({ bucket: f.key === 'wrong' ? null : f.key })}
                class="rounded px-2.5 py-1 text-xs font-medium {f.key === data.bucketFilter
                  ? 'bg-blue-8/25 text-blue-3'
                  : 'bg-dark-7 text-dark-2 hover:text-dark-0'}"
              >
                {f.label} <span class="font-mono opacity-70">{countFor(f.key)}</span>
              </a>
            {/each}
          </div>
        </div>

        {#if data.truncated}
          <p class="text-xs text-dark-3">Showing the first 250 rows by score. Narrow the bucket to see more.</p>
        {/if}

        {#if rows.length === 0}
          <section class="rounded-xl border border-dark-4 bg-dark-6 p-8 text-center text-sm text-dark-2">
            Nothing in this bucket.
          </section>
        {:else}
          {#each rows as r (r.id)}
            <article class="rounded-xl border border-dark-4 bg-dark-6 p-4">
              <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span class="rounded px-1.5 py-0.5 font-semibold {BUCKET_STYLE[r.bucket ?? 'error']}">
                  {r.bucket ?? 'error'}
                </span>
                <span class="font-mono text-dark-0">
                  {r.score === null ? 'no score' : r.score.toFixed(3)}
                </span>
                <span class="text-dark-3">expected {r.expected ? 'yes' : 'no'}</span>
                <span class="text-dark-3">batch {r.batch}</span>
                <a
                  href="/xguard?label={s.label}&sample={r.sampleId}"
                  class="ml-auto text-blue-4 hover:text-blue-3"
                >
                  Review this sample &rarr;
                </a>
              </div>

              <p class="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-dark-0">
                {#each expanded.has(r.id) ? r.full : r.head as piece, i (i)}{#if piece.className}<mark
                    class="rounded px-0.5 {piece.className}">{piece.text}</mark
                  >{:else}{piece.text}{/if}{/each}
              </p>

              {#if r.long}
                <button
                  type="button"
                  onclick={() => toggle(r.id)}
                  class="mt-1 text-xs text-blue-4 hover:text-blue-3"
                >
                  {expanded.has(r.id) ? 'Show less' : `Show all ${r.positivePrompt.length} chars`}
                </button>
              {/if}

              {#if r.reason}
                <p class="mt-2 border-t border-dark-5 pt-2 text-sm leading-relaxed text-dark-1">{r.reason}</p>
              {/if}
              {#if r.error}
                <p class="mt-2 rounded bg-red-8/15 px-2 py-1 text-xs text-red-3">{r.error}</p>
              {/if}
            </article>
          {/each}
        {/if}
      </div>
    {/if}
  </section>
{/if}

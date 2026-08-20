<script lang="ts">
  import type { PageData } from './$types';
  import { fmtMetric, precisionOf, recallOf } from '$lib/eval-metrics';

  let { data }: { data: PageData } = $props();

  // Recall is unmeasurable without confirmed positives, so a label with plenty of reviews and no
  // positives looks healthy on every other number while being useless for tuning. Say it plainly.
  function blocker(l: PageData['labels'][number]): string | null {
    if (l.rated === 0) return 'no AI ratings yet';
    if (l.confirmed === 0) return 'nothing confirmed by a human yet';
    if (l.positives === 0) return 'no confirmed positives, so recall cannot be measured';
    if (!l.policyVersion) return 'no policy imported, so nothing to evaluate';
    return null;
  }
</script>

<header class="page-header">
  <h1>Labels</h1>
  <p>
    What exists, how much of it is confirmed, and what the last evaluation said.
    <a href="/xguard/docs" class="text-blue-4 hover:text-blue-3">Operator guide &amp; API &rarr;</a>
  </p>
</header>

{#if data.labels.length === 0}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-8 text-center text-sm text-dark-2">
    No labels yet. Run the rater to create one.
  </section>
{:else}
  <div class="flex flex-col gap-3">
    {#each data.labels as l (l.name)}
      {@const stop = blocker(l)}
      <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
        <div class="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 class="text-base font-semibold text-white">{l.name}</h2>
          {#if l.policyVersion}
            <span class="rounded bg-dark-7 px-2 py-0.5 text-xs text-dark-1">policy v{l.policyVersion}</span>
          {/if}
          <div class="ml-auto flex gap-3 text-xs">
            <a href="/xguard/labels/{l.name}" class="text-blue-4 hover:text-blue-3">Policy</a>
            <a href="/xguard?label={l.name}" class="text-blue-4 hover:text-blue-3">Review &rarr;</a>
          </div>
        </div>

        <p class="mb-4 text-sm text-dark-2">{l.description}</p>

        <div class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {#each [['rated', l.rated], ['rater said yes', l.ratedPositive], ['confirmed', l.confirmed], ['confirmed yes', l.positives]] as [label, value] (label)}
            <div class="rounded-lg bg-dark-7 px-3 py-2">
              <div class="text-xs text-dark-3">{label}</div>
              <div class="font-mono text-lg text-dark-0">{value}</div>
            </div>
          {/each}
        </div>

        {#if stop}
          <div class="rounded-lg bg-red-8/15 px-3 py-2 text-sm text-red-3">{stop}</div>
        {:else if l.lastRun}
          {@const r = l.lastRun}
          <div class="rounded-lg bg-dark-7 px-3 py-2.5">
            <div class="mb-1.5 flex items-baseline gap-2 text-xs text-dark-3">
              <span>last run</span>
              <span class="text-dark-1">{r.policyLabel} @ {r.threshold}</span>
              <span class="ml-auto">{new Date(r.startedAt).toLocaleString()}</span>
            </div>
            <div class="flex flex-wrap gap-x-5 gap-y-1 font-mono text-sm">
              <span class="text-green-3">TP {r.tp}</span>
              <span class="text-red-3">FP {r.fp}</span>
              <span class="text-dark-1">TN {r.tn}</span>
              <span class="text-red-3">FN {r.fn}</span>
              <span class="text-dark-0">P {fmtMetric(precisionOf(r))}</span>
              <span class="text-dark-0">R {fmtMetric(recallOf(r))}</span>
            </div>
          </div>
        {:else}
          <div class="rounded-lg bg-dark-7 px-3 py-2 text-sm text-dark-3">
            Ready to evaluate, but no run yet.
          </div>
        {/if}
      </section>
    {/each}
  </div>
{/if}

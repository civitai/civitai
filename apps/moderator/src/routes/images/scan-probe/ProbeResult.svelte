<script lang="ts">
  import { browser } from '$app/environment';
  import { keepLast } from '$lib/keep-last.svelte';
  import type { ProbeResult, ProbeRun } from '$lib/scan-probe';

  let { run }: { run: ProbeRun } = $props();

  const POLL_MS = 3000;
  const MAX_POLLS = 40;

  let polls = $state(0);

  const result = keepLast<ProbeResult>(() => {
    if (!browser) return null;
    void polls;
    return fetch(`/images/scan-probe/runs/${run.id}`).then((r): Promise<ProbeResult> => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  });

  const r = $derived(result.value);
  const settled = $derived(
    r !== null && (r.state === 'done' || r.state === 'submit-failed' || r.state === 'unavailable')
  );

  // The next poll is scheduled only once the last answered: a read slower than the interval would
  // otherwise be superseded by the next request every time, and never land.
  $effect(() => {
    if (settled || result.loading || polls >= MAX_POLLS) return;
    const timer = setTimeout(() => (polls += 1), POLL_MS);
    return () => clearTimeout(timer);
  });

  const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);
  const yesNo = (b: boolean | null) => (b === null ? '—' : b ? 'yes' : 'no');
</script>

<div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex items-baseline justify-between gap-3">
    <h3 class="text-white">Image {run.imageId}</h3>
    <span class="text-xs text-dark-2">run {run.id} · {new Date(run.createdAt).toLocaleString()}</span>
  </div>

  {#if !r}
    <p class="mt-2 text-sm text-dark-2">
      {result.failed || polls >= MAX_POLLS ? 'Could not load this result.' : 'Checking…'}
    </p>
  {:else if r.state === 'pending'}
    <p class="mt-2 text-sm text-dark-2">Submit outcome not recorded yet.</p>
  {:else if r.state === 'submit-failed'}
    <p class="mt-2 text-sm text-red-300">The scan could not be submitted.</p>
  {:else if r.state === 'unavailable'}
    <p class="mt-2 text-sm text-red-300">The orchestrator has no result for this run.</p>
  {:else if r.state === 'running'}
    <p class="mt-2 text-sm text-dark-2">
      {polls >= MAX_POLLS ? 'Still running — reload to check again.' : `Running (${r.workflowStatus})…`}
    </p>
  {:else if !r.signals}
    <p class="mt-2 text-sm text-dark-2">Finished ({r.workflowStatus}) with no scan output.</p>
  {:else}
    {@const s = r.signals}
    <p class="mt-1 text-xs text-dark-2">May be a cached verdict.</p>
    <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
      <dt class="text-dark-2">Workflow</dt><dd class="text-dark-0">{r.workflowStatus}</dd>
      <dt class="text-dark-2">NSFW level</dt><dd class="text-dark-0">{s.nsfwLevel ?? '—'}</dd>
      <dt class="text-dark-2">Score</dt><dd class="text-dark-0">{pct(s.score)}</dd>
      <dt class="text-dark-2">CSAM</dt><dd class="text-dark-0">{yesNo(s.csam)}</dd>
      <dt class="text-dark-2">Blocked reason</dt><dd class="text-dark-0">{s.blockedReason ?? '—'}</dd>
      <dt class="text-dark-2">AI</dt>
      <dd class="text-dark-0">{s.aiRecognition ? `${s.aiRecognition.label} ${pct(s.aiRecognition.score)}` : '—'}</dd>
      <dt class="text-dark-2">Anime</dt>
      <dd class="text-dark-0">{s.animeRecognition ? `${s.animeRecognition.label} ${pct(s.animeRecognition.score)}` : '—'}</dd>
      <dt class="text-dark-2">Human</dt>
      <dd class="text-dark-0">{s.human ? `${s.human.label} ${pct(s.human.score)}` : '—'}</dd>
    </dl>

    {#if s.age}
      <p class="mt-3 text-sm text-dark-2">
        Age ({s.age.status ?? '—'}): child {yesNo(s.age.childDetected)}, minor {yesNo(s.age.minorDetected)},
        out of distribution {yesNo(s.age.oodDetected)}
      </p>
      {#if s.age.detections.length}
        <table class="mt-2 w-full text-left text-sm">
          <thead class="text-dark-2">
            <tr><th>#</th><th>Domain</th><th>Age</th><th>Band</th><th>&lt;13</th><th>&lt;18</th><th>Child</th><th>Minor</th></tr>
          </thead>
          <tbody class="text-dark-0">
            {#each s.age.detections as d, i (i)}
              <tr>
                <td>{i + 1}</td><td>{d.domain ?? '—'}</td><td>{d.apparentAge?.toFixed(1) ?? '—'}</td>
                <td>{d.ageBand ?? '—'}</td><td>{pct(d.under13Probability)}</td><td>{pct(d.under18Probability)}</td>
                <td>{yesNo(d.isChild)}</td><td>{yesNo(d.isMinor)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {/if}

    {#if s.tags.length}
      <p class="mt-3 text-sm text-dark-2">
        Tags:
        {#each s.tags as t (`${t.category}:${t.tag}`)}
          <span class="mr-2 text-dark-0">{t.tag} <span class="text-dark-2">{pct(t.score)}</span></span>
        {/each}
      </p>
    {/if}
  {/if}
</div>

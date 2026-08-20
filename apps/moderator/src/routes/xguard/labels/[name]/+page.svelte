<script lang="ts">
  import { enhance } from '$app/forms';
  import type { ActionData, PageData } from './$types';
  import { fmtMetric, precisionOf, recallOf } from '$lib/eval-metrics';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const latest = $derived(data.versions[0] ?? null);

  let policy = $state('');
  let threshold = $state(0.5);
  let action = $state('Scan');
  let note = $state('');
  let evaluating = $state(false);

  // Seed the editor from the newest version whenever the label changes, so opening the page shows
  // what is current rather than an empty box.
  let seededFor = $state<string | null>(null);
  $effect(() => {
    if (seededFor === data.label.name) return;
    seededFor = data.label.name;
    policy = latest?.policy ?? '';
    threshold = latest?.threshold ?? 0.5;
    action = latest?.action ?? 'Scan';
    note = '';
  });

  const dirty = $derived(
    latest === null ||
      policy !== latest.policy ||
      threshold !== latest.threshold ||
      action !== latest.action
  );

  // Recall needs confirmed positives. Saying so up front beats letting someone run an evaluation
  // and puzzle over a row of n/a.
  const measurable = $derived(data.groundTruth.positives > 0);
</script>

<header class="page-header">
  <h1>{data.label.name}</h1>
  <p>{data.label.description}</p>
</header>

<div class="mb-4 flex flex-wrap items-center gap-3 text-xs">
  <a href="/xguard/labels" class="rounded bg-dark-7 px-2.5 py-1 text-dark-2 hover:text-dark-0">
    All labels
  </a>
  <a href="/xguard?label={data.label.name}" class="rounded bg-dark-7 px-2.5 py-1 text-dark-2 hover:text-dark-0">
    Review
  </a>
  <span class="text-dark-3">
    {data.groundTruth.confirmed} confirmed &middot; {data.groundTruth.positives} positive
  </span>
  {#if !measurable}
    <span class="rounded bg-red-8/15 px-2 py-1 text-red-3">
      No confirmed positives, so recall will come back n/a
    </span>
  {/if}
</div>

{#if form && 'message' in form && form.message}
  <div class="mb-4 rounded-lg bg-red-8/20 px-3 py-2 text-sm text-red-2">{form.message}</div>
{/if}
{#if form && 'saved' in form && form.saved}
  <div class="mb-4 rounded-lg bg-green-8/20 px-3 py-2 text-sm text-green-2">
    Saved as v{form.saved}.
  </div>
{/if}
{#if form && 'evaluated' in form && form.evaluated}
  {@const e = form.evaluated}
  <div class="mb-4 rounded-lg bg-dark-7 px-3 py-2.5">
    <div class="mb-1 text-xs text-dark-3">run {e.runId} &middot; {e.policyLabel} @ {e.threshold}</div>
    <div class="flex flex-wrap gap-x-5 gap-y-1 font-mono text-sm">
      <span class="text-green-3">TP {e.tp}</span>
      <span class="text-red-3">FP {e.fp}</span>
      <span class="text-dark-1">TN {e.tn}</span>
      <span class="text-red-3">FN {e.fn}</span>
      <span class="text-dark-0">P {fmtMetric(precisionOf(e))}</span>
      <span class="text-dark-0">R {fmtMetric(recallOf(e))}</span>
    </div>
  </div>
{/if}

<section class="grid gap-4 lg:grid-cols-[1fr_22rem]">
  <form
    method="POST"
    action="?/save"
    use:enhance
    class="rounded-xl border border-dark-4 bg-dark-6 p-5"
  >
    <div class="mb-3 flex items-baseline justify-between">
      <span class="text-xs font-medium uppercase tracking-wider text-dark-2">Policy</span>
      <span class="text-xs text-dark-3">
        {#if latest}editing from v{latest.version}{:else}no versions yet{/if}
      </span>
    </div>

    <textarea
      name="policy"
      bind:value={policy}
      rows="22"
      spellcheck="false"
      class="w-full rounded-lg border border-dark-4 bg-dark-8 p-3 font-mono text-xs leading-relaxed text-dark-0 focus:border-blue-6 focus:outline-none"
    ></textarea>

    <div class="mt-3 flex flex-wrap items-end gap-3">
      <label class="flex flex-col gap-1">
        <span class="text-xs text-dark-2">Threshold</span>
        <input
          name="threshold"
          type="number"
          min="0"
          max="1"
          step="0.05"
          bind:value={threshold}
          class="w-24 rounded border border-dark-4 bg-dark-8 px-2 py-1 text-sm text-dark-0"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-xs text-dark-2">Action</span>
        <select
          name="action"
          bind:value={action}
          class="rounded border border-dark-4 bg-dark-8 px-2 py-1 text-sm text-dark-0"
        >
          <option value="Scan">Scan</option>
          <option value="Block">Block</option>
        </select>
      </label>
      <label class="flex flex-1 flex-col gap-1">
        <span class="text-xs text-dark-2">Note</span>
        <input
          name="note"
          bind:value={note}
          placeholder="what changed and why"
          class="w-full rounded border border-dark-4 bg-dark-8 px-2 py-1 text-sm text-dark-0"
        />
      </label>
      <button
        type="submit"
        disabled={!dirty}
        class="rounded-lg bg-blue-8/30 px-4 py-2 text-sm font-semibold text-blue-2 hover:bg-blue-8/50 disabled:opacity-40"
      >
        {dirty ? 'Save as new version' : 'No changes'}
      </button>
    </div>
  </form>

  <div class="flex flex-col gap-4">
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <div class="mb-3 text-xs font-medium uppercase tracking-wider text-dark-2">Versions</div>
      {#if data.versions.length === 0}
        <p class="text-sm text-dark-3">Nothing saved yet.</p>
      {:else}
        <div class="flex flex-col gap-2">
          {#each data.versions as v (v.id)}
            <form
              method="POST"
              action="?/evaluate"
              use:enhance={() => {
                evaluating = true;
                return async ({ update }) => {
                  await update({ reset: false });
                  evaluating = false;
                };
              }}
              class="flex items-center gap-2 rounded-lg bg-dark-7 px-3 py-2"
            >
              <input type="hidden" name="version" value={v.version} />
              <div class="min-w-0 flex-1">
                <div class="text-sm text-dark-0">v{v.version} &middot; {v.threshold} &middot; {v.action}</div>
                {#if v.note}<div class="truncate text-xs text-dark-3">{v.note}</div>{/if}
              </div>
              <button
                type="submit"
                disabled={evaluating}
                class="shrink-0 rounded bg-dark-5 px-2.5 py-1 text-xs text-dark-1 hover:text-dark-0 disabled:opacity-40"
              >
                {evaluating ? 'Running…' : 'Evaluate'}
              </button>
            </form>
          {/each}
        </div>
      {/if}
    </div>

    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <div class="mb-3 text-xs font-medium uppercase tracking-wider text-dark-2">Recent runs</div>
      {#if data.runs.length === 0}
        <p class="text-sm text-dark-3">No runs yet.</p>
      {:else}
        <div class="flex flex-col gap-2">
          {#each data.runs as r (r.id)}
            <div class="rounded-lg bg-dark-7 px-3 py-2">
              <div class="flex items-baseline justify-between text-xs text-dark-3">
                <span class="text-dark-1">{r.policyLabel} @ {r.threshold}</span>
                <span>{new Date(r.startedAt).toLocaleString()}</span>
              </div>
              <div class="mt-1 flex flex-wrap gap-x-3 font-mono text-xs">
                <span class="text-green-3">TP {r.tp}</span>
                <span class="text-red-3">FP {r.fp}</span>
                <span class="text-dark-1">TN {r.tn}</span>
                <span class="text-red-3">FN {r.fn}</span>
                <span class="text-dark-0">P {fmtMetric(precisionOf(r))}</span>
                <span class="text-dark-0">R {fmtMetric(recallOf(r))}</span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</section>

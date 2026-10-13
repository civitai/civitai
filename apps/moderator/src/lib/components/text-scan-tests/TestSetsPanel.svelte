<script lang="ts">
  import { browser } from '$app/environment';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { fetchJson } from '$lib/fetch-json';
  import { LINK_CLASS, dateTime, type Jsonified } from '$lib/format';
  import { keepLast } from '$lib/keep-last.svelte';
  import type { SetOverview } from '$lib/server/text-scan-tests/reports';
  import { LABEL_NAMES } from '$lib/text-scan-lab/labels';
  import type { LabelSummary } from '$lib/text-scan-tests/score';
  import type { Workspace } from '$lib/text-scan-tests/types';
  import RunDialog from './RunDialog.svelte';
  import RunProgress from './RunProgress.svelte';

  let {
    workspace,
    visible,
    prompts,
    rules,
    hasDraft,
    draftsError,
    canEdit,
    userId,
  }: {
    workspace: Workspace;
    visible: boolean;
    prompts: string;
    rules: string;
    hasDraft: boolean;
    draftsError: string | null;
    canEdit: boolean;
    userId: number;
  } = $props();

  type SetOption = { id: number; name: string; caseCount: number };
  type Overview = Jsonified<SetOverview>;
  const POLL_MS = 4000;

  let selected = $state<number | null>(null);
  let version = $state(0);

  const sets = $derived(
    browser && visible
      ? fetchJson<{ sets: SetOption[] }>(`/text-scan/test-sets/sets?workspace=${workspace}`)
      : null
  );
  const overview = keepLast(() =>
    browser && visible && selected !== null
      ? fetchJson<Overview>(`/text-scan/test-sets/${selected}/overview?v=${version}`)
      : null
  );
  const running = $derived(!!overview.value?.active.length);

  $effect(() => {
    if (!visible || !running) return;
    const timer = setInterval(() => version++, POLL_MS);
    return () => clearInterval(timer);
  });

  const BASELINE_LINE: Record<Overview['baseline']['state'], string> = {
    fresh: 'Baseline up to date',
    running: 'Baseline running',
    stale: 'Baseline out of date: the next run refreshes it',
    none: 'No baseline yet: the first run makes one',
    unknown: 'Could not check the baseline against the live prompts',
  };

  const scores = (totals: LabelSummary[] | null) =>
    (totals ?? []).map((t) => `${LABEL_NAMES[t.label]} ${t.passed}/${t.scored}`).join(' · ');
</script>

<section class="space-y-4 rounded-xl border border-dark-4 bg-dark-6 p-5" aria-label="Test sets">
  {#await sets}
    <p class="text-sm text-dark-2">Loading test sets…</p>
  {:then loaded}
    {@const options = loaded?.sets ?? []}
    {#if !options.length}
      <p class="text-sm text-dark-2">
        No test sets yet. Use "Add to test set" on a Try result to start one.
      </p>
    {:else}
      <Select.Root
        type="single"
        bind:value={
          () => (selected === null ? '' : String(selected)),
          (v) => (selected = v ? Number(v) : null)
        }
      >
        <Select.Trigger class="w-full" aria-label="Test set">
          {options.find((s) => s.id === selected)?.name ?? 'Pick a test set'}
        </Select.Trigger>
        <Select.Content>
          {#each options as set (set.id)}
            <Select.Item value={String(set.id)}>{set.name} · {set.caseCount} cases</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load the test sets.</p>
  {/await}

  {#if selected !== null}
    {#if overview.value}
      {@const o = overview.value}
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <p class="text-sm text-dark-0">
          {o.cases.runnable} cases{#if o.cases.wiped} · {o.cases.wiped} with text removed{/if}
        </p>
        <a href="/text-scan/test-sets/{o.set.id}" class={LINK_CLASS}>Open set</a>
      </div>
      <p class="text-xs text-dark-2">
        {BASELINE_LINE[o.baseline.state]}{#if o.baseline.state === 'fresh' && o.baseline.run?.finishedAt}
          · {dateTime(o.baseline.run.finishedAt)}{/if}
      </p>
      {#if draftsError}
        <p class="text-sm text-amber-300">{draftsError}</p>
      {/if}
      <RunDialog
        setId={o.set.id}
        {prompts}
        {rules}
        label={hasDraft ? 'Run with my draft' : 'Run baseline'}
        disabled={!!draftsError || o.active.length > 0}
        onstarted={() => version++}
      />
      {#each o.active as run (run.id)}
        <RunProgress {run} canCancel={run.runBy === userId || canEdit} onchanged={() => version++} />
      {/each}
      {#if o.recent.length}
        <div>
          <h3 class="text-xs font-semibold uppercase tracking-wide text-dark-2">Recent runs</h3>
          <ul class="mt-2 space-y-1">
            {#each o.recent as run (run.id)}
              <li class="text-sm">
                <a href="/text-scan/test-sets/{o.set.id}/runs/{run.id}" class={LINK_CLASS}>
                  #{run.id} {run.kind === 'baseline' ? 'Baseline' : 'Draft'} · {run.status}
                </a>
                <span class="text-xs text-dark-2">
                  {dateTime(run.finishedAt)}{#if run.totals?.length} · {scores(run.totals)}{/if}
                </span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    {:else if overview.failed}
      <p class="text-sm text-red-300">Could not load this set.</p>
    {:else}
      <p class="text-sm text-dark-2">Loading…</p>
    {/if}
  {/if}
</section>

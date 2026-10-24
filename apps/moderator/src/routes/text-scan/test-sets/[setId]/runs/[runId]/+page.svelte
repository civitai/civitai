<script lang="ts">
  import { formatVersions } from '$lib/text-scan-tests/format';
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import CaseOutcomeRow from '$lib/components/text-scan-tests/CaseOutcomeRow.svelte';
  import RunProgress from '$lib/components/text-scan-tests/RunProgress.svelte';
  import RunSummaryTable from '$lib/components/text-scan-tests/RunSummaryTable.svelte';
  import { fetchJson } from '$lib/fetch-json';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, plural, type Jsonified } from '$lib/format';
  import { keepLast } from '$lib/keep-last.svelte';
  import type { RunView } from '$lib/server/text-scan-tests/reports';
  import { RUN_KIND_NAMES, RUN_POLL_MS, isActiveRun } from '$lib/text-scan-tests/types';

  let { data } = $props();

  const report = $derived(data.report);
  const active = $derived(isActiveRun(report.run.status));
  const open = $derived(!report.set.archivedAt);

  let tick = $state(0);
  const progress = keepLast(() =>
    browser && active
      ? fetchJson<Jsonified<RunView>>(
          `/text-scan/test-sets/${report.set.id}/runs/${report.run.id}/progress?v=${tick}`
        )
      : null
  );
  $effect(() => {
    if (!active) return;
    const timer = setInterval(() => tick++, RUN_POLL_MS);
    return () => clearInterval(timer);
  });
  $effect(() => {
    const status = progress.value?.status;
    if (active && status && !isActiveRun(status)) void invalidateAll();
  });

  // One per run, so a refusal shown for one run is gone on the next.
  const rerun = $derived.by(() => {
    void report.run.id;
    return new FormState({ reset: false, reload: true, onSuccess: null });
  });
  const errorCount = $derived(
    report.cases.filter((c) => (c.draft ?? c.baseline)?.result?.status === 'error').length
  );
  const versions = $derived(formatVersions(report.run.promptIds));
  const title = $derived(
    `${RUN_KIND_NAMES[report.run.kind]} run #${report.run.id}`
  );
</script>

<svelte:head><title>{title} · {report.set.name}</title></svelte:head>

<div class="mb-4">
  <a href="/text-scan/test-sets/{report.set.id}" class="text-xs {LINK_CLASS}">← {report.set.name}</a>
  <h1 class="text-xl font-semibold text-white">{title}</h1>
  <p class="text-xs text-dark-2">
    {report.run.status} · started {dateTime(report.run.startedAt ?? report.run.createdAt)}
    {#if report.run.finishedAt && !active}· finished {dateTime(report.run.finishedAt)}{/if}
    · versions <span class="font-mono">{versions}</span>
    {#if report.run.overriddenKeys.length}· draft of {report.run.overriddenKeys.join(', ')}{/if}
  </p>
  {#if report.baselineRun}
    <p class="text-xs text-dark-2">
      Compared with
      <a
        href="/text-scan/test-sets/{report.set.id}/runs/{report.baselineRun.id}"
        class={LINK_CLASS}
      >
        baseline #{report.baselineRun.id}
      </a>
    </p>
  {/if}
  {#if report.run.failure}<p class="mt-2 text-sm text-red-300">{report.run.failure}</p>{/if}
</div>

{#key report.run.id}
  <div class="space-y-6">
    {#if active}
      {#if progress.value}
        <RunProgress
          run={progress.value}
          canCancel={report.run.runBy === data.userId || data.canEdit}
          onchanged={() => tick++}
        />
      {:else if !progress.failed}
        <p class="text-sm text-dark-2">Loading progress…</p>
      {/if}
      {#if progress.failed}
        <p class="text-xs text-amber-300">
          Could not refresh the progress{progress.value ? '; this is the last reading' : ''}.
        </p>
      {/if}
    {/if}

    <RunSummaryTable
      summary={report.summary}
      hasBaseline={report.counts.baseline !== null}
      hasDraft={report.counts.draft !== null}
    />

    {#if open && !active && errorCount}
      <form
        method="POST"
        action="?/rerunErrors"
        use:enhance={rerun.enhance}
        class="flex items-center gap-3"
      >
        <input type="hidden" name="setId" value={report.set.id} />
        <input type="hidden" name="runId" value={report.run.id} />
        <Button type="submit" size="sm" variant="outline" disabled={rerun.submitting}>
          Re-run {plural(errorCount, 'error')}
        </Button>
        <span class="text-xs text-dark-2">Errors are never scored as misses.</span>
      </form>
      {#if rerun.error}<p class="text-sm text-red-300">{rerun.error}</p>{/if}
    {/if}

    <section class="space-y-3">
      <h2 class="text-sm font-semibold text-white">Cases, changed first</h2>
      {#each report.cases as row (row.caseId)}
        <CaseOutcomeRow
          {row}
          canEdit={data.canEdit && open}
          setId={report.set.id}
        />
      {:else}
        <p class="text-sm text-dark-2">This run has no cases.</p>
      {/each}
    </section>
  </div>
{/key}

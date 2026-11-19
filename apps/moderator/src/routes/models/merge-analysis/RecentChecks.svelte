<script lang="ts">
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { dateTime } from '$lib/format';
  import { keepLast } from '$lib/keep-last.svelte';
  import { MERGE_ANALYSIS_PATH, reportTitle, type MergeAnalysis } from '$lib/model-merge-analysis';

  let { checks }: { checks: Promise<MergeAnalysis[] | null> } = $props();

  // Kept across the running check's polls, which re-run the load and hand down a new promise each time.
  const recent = keepLast(() =>
    checks.then((list) => list ?? Promise.reject(new Error('recent checks unavailable')))
  );

  const status = (check: MergeAnalysis) =>
    check.state === 'running'
      ? 'Checking…'
      : check.state === 'failed' || !check.report
        ? 'Could not complete'
        : reportTitle(check.report, check.labels?.loras.length ?? 0);
</script>

<section class="flex flex-col gap-2 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="text-white">Recent checks</h2>
  {#if recent.value}
    <ul class="flex flex-col gap-1 text-sm">
      {#each recent.value as check (check.workflowId)}
        <li>
          <a
            class="flex flex-wrap gap-x-3 rounded px-2 py-1 hover:bg-dark-5"
            href="{MERGE_ANALYSIS_PATH}?workflow={encodeURIComponent(check.workflowId)}"
          >
            <span class="text-white">{check.labels?.checkpoint ?? check.workflowId}</span>
            <span class="text-dark-2">{status(check)}</span>
            {#if check.createdAt}
              <span class="text-dark-2">{dateTime(check.createdAt)}</span>
            {/if}
          </a>
        </li>
      {:else}
        <li class="text-dark-2">No checks yet.</li>
      {/each}
    </ul>
  {:else if recent.failed}
    <ErrorAlert message="Could not load recent checks." />
  {:else}
    <p class="text-sm text-dark-2">Loading recent checks…</p>
  {/if}
</section>

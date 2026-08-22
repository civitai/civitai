<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { Account, TrainingRun } from './user-account';

  let { account, civitaiUrl }: { account: Promise<Account> | null; civitaiUrl: string } = $props();

  const SHOWN = 5;
  let expanded = $state(false);

  const statusVariant = (status: string | null) =>
    status === 'Failed' || status === 'Denied'
      ? ('destructive' as const)
      : ('secondary' as const);

  // Rendered as whatever the run actually carries rather than a chosen list of fields: the key set
  // varies by engine, so a fixed table would quietly omit whatever the next one adds. Objects and
  // arrays (`optimizerArgs`) are stringified rather than skipped.
  const paramEntries = (run: TrainingRun) =>
    Object.entries(run.params ?? {})
      .filter(([, v]) => v !== null && v !== '' && v !== undefined)
      .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)] as const)
      .sort(([a], [b]) => a.localeCompare(b));

  const submitted = (run: TrainingRun) => run.history?.filter((h) => h.status === 'Submitted') ?? [];

  const progress = (run: TrainingRun) =>
    run.currentEpoch === null && run.maxEpochs === null
      ? null
      : `${run.currentEpoch ?? '?'}/${run.maxEpochs ?? '?'} epochs`;
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Training runs</h3>
  <p class="mb-3 text-xs text-dark-2">
    LoRA trainings this account submitted — what was trained, how far it got and what it cost. One row
    per trained model version; a retrain reuses the version, so the run count is on the row.
  </p>

  {#await account}
    <p class="text-sm text-dark-2">Loading training runs…</p>
  {:then result}
    {#if !result}
      <p class="text-sm text-dark-2">Loading training runs…</p>
    {:else}
      {@const charges = result.trainings.charges}
      {#if charges}
        <p class="mb-3 text-xs text-dark-2">
          Buzz ledger: {num(charges.count)} paid runs
          {#if charges.first && charges.last}
            between {dateTime(charges.first)} and {dateTime(charges.last)},
          {/if}
          costing {num(charges.buzz)} Buzz.
        </p>
      {/if}
      {#if result.trainings.runs.length === 0}
        <p class="text-sm text-dark-2">No training runs on this account.</p>
      {:else}
        <ul class="space-y-2 text-sm">
          {#each expanded ? result.trainings.runs : result.trainings.runs.slice(0, SHOWN) as run (run.modelVersionId)}
            {@const steps = progress(run)}
            <li class="border-b border-dark-4 pb-2 last:border-0 last:pb-0">
              <div class="flex flex-wrap items-baseline gap-x-2">
                <a
                  href="{civitaiUrl}/models/{run.modelId}?modelVersionId={run.modelVersionId}"
                  target="_blank"
                  rel="noreferrer"
                  class={LINK_CLASS}
                >
                  {run.modelName ?? `model ${run.modelId}`}
                </a>
                <span class="text-xs text-dark-2">{run.name ?? `version ${run.modelVersionId}`}</span>
                {#if run.status}
                  <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                {/if}
                {#if run.sharedDataset}
                  <Badge variant="secondary">dataset shared</Badge>
                {/if}
                {#if (run.submitCount ?? 0) > 1}
                  <Badge variant="secondary">{run.submitCount} runs</Badge>
                {/if}
              </div>
              <div class="mt-0.5 flex flex-wrap items-baseline gap-x-3 text-xs text-dark-2">
                {#if run.baseModel}<span>{run.baseModel}</span>{/if}
                {#if run.trainingType}<span>{run.trainingType}</span>{/if}
                {#if run.numImages !== null}<span>{num(run.numImages)} images</span>{/if}
                {#if steps}<span>{steps}</span>{/if}
                {#if run.buzzCost !== null}<span>{num(run.buzzCost)} buzz</span>{/if}
                <span>{dateTime(run.startedAt)}</span>
              </div>
              {#if (run.submitCount ?? 0) > 1}
                {@const submissions = submitted(run)}
                <details class="mt-1">
                  <summary class="cursor-pointer text-xs text-dark-2">
                    Retrained {run.submitCount} times on this version — only the last run's parameters and
                    results are kept
                  </summary>
                  <ul class="mt-1 space-y-0.5 text-xs text-dark-2">
                    {#each submissions as sub, i (`${sub.time}-${i}`)}
                      <li>run {i + 1} submitted {dateTime(sub.time)}</li>
                    {/each}
                  </ul>
                </details>
              {/if}
              {#if paramEntries(run).length}
                {@const params = paramEntries(run)}
                <details class="mt-1">
                  <summary class="cursor-pointer text-xs text-dark-2">
                    Training parameters ({params.length}){run.engine ? ` · ${run.engine}` : ''}
                  </summary>
                  <dl
                    class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr_auto_1fr]"
                  >
                    {#each params as [key, value] (key)}
                      <dt class="text-dark-2">{key}</dt>
                      <dd class="break-all text-dark-0">{value}</dd>
                    {/each}
                  </dl>
                </details>
              {/if}
            </li>
          {/each}
        </ul>
        {#if result.trainings.runs.length > SHOWN}
          <button type="button" class="mt-3 text-sm {LINK_CLASS}" onclick={() => (expanded = !expanded)}>
            {expanded ? 'Show less' : `Show ${result.trainings.runs.length} loaded`}
          </button>
        {/if}
        {#if result.trainings.truncated}
          <p class="mt-2 text-xs text-amber-300">
            Capped at {result.trainings.runs.length} — this account has more training runs than are shown.
          </p>
        {/if}
      {/if}

      {#if charges && charges.unmatched.length}
        <h4 class="mb-1 mt-4 text-sm font-semibold text-white">
          Runs with no surviving record ({num(charges.unmatched.length)})
        </h4>
        <p class="mb-2 text-xs text-dark-2">
          Charged for, so they ran. A training whose model is still a draft 30 days later is deleted
          outright — version, dataset and results together — so the charge and the orchestrator's run id
          are what survive. The name the account gave it does not.
        </p>
        <ul class="space-y-1 text-sm">
          {#each charges.unmatched as charge (charge.id)}
            <li class="flex flex-wrap items-baseline gap-x-3 border-b border-dark-4 pb-1 last:border-0">
              <span class="text-dark-0">{dateTime(charge.date)}</span>
              <span class="text-xs text-dark-2">{num(charge.buzz)} buzz</span>
              {#if charge.workflowId}
                <span class="break-all font-mono text-xs text-dark-2">{charge.workflowId}</span>
              {/if}
            </li>
          {/each}
        </ul>
        {#if charges.truncated}
          <p class="mt-2 text-xs text-amber-300">
            Capped at {num(charges.unmatched.length)} — this account has more.
          </p>
        {/if}
      {/if}
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load training runs.</p>
  {/await}
</section>

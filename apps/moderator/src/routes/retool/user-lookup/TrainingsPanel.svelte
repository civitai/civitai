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

  const progress = (run: TrainingRun) =>
    run.currentEpoch === null && run.maxEpochs === null
      ? null
      : `${run.currentEpoch ?? '?'}/${run.maxEpochs ?? '?'} epochs`;
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Training runs</h3>
  <p class="mb-3 text-xs text-dark-2">
    LoRA trainings this account submitted — what was trained, how far it got and what it cost.
  </p>

  {#await account}
    <p class="text-sm text-dark-2">Loading training runs…</p>
  {:then result}
    {#if !result}
      <p class="text-sm text-dark-2">Loading training runs…</p>
    {:else if result.trainings.runs.length === 0}
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
                {run.name ?? `version ${run.modelVersionId}`}
              </a>
              {#if run.status}
                <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
              {/if}
              {#if run.sharedDataset}
                <Badge variant="secondary">dataset shared</Badge>
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
  {:catch}
    <p class="text-sm text-red-300">Could not load training runs.</p>
  {/await}
</section>

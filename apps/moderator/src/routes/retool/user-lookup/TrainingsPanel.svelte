<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num, utcMs } from '$lib/format';
  import type { Account, TrainingRun } from './user-account';
  import {
    fetchTrainingOrchestration,
    type TrainingOrchestration,
  } from './training-orchestration';

  type UnmatchedCharges = NonNullable<Account['trainings']['charges']>;

  let {
    account,
    userId,
    civitaiUrl,
  }: { account: Promise<Account> | null; userId: number; civitaiUrl: string } = $props();

  const SHOWN = 5;
  let expanded = $state(false);

  const spanDays = (rows: { date: string }[]) => {
    const times = rows.map((r) => utcMs(r.date)).filter((t) => !isNaN(t));
    return times.length ? (Math.max(...times) - Math.min(...times)) / 86_400_000 : 0;
  };

  const olderThan = (date: string, floor: string | null) =>
    !!floor && utcMs(date) < utcMs(floor);

  let withStatus = $state(false);

  // Paged for cost, not for screen space: the lookup scans a window as wide as the oldest row shown.
  const PAGE = 10;
  let shown = $state(PAGE);

  // 🔴 `shown`, `withStatus` and `userId` MUST be read here, not inside the `.then`. A derived collects
  // its dependencies from what it reads synchronously; the callback runs a microtask later, with the
  // tracking context already gone. Read them in there and the promise never rebuilds — both buttons
  // below go inert while still re-rendering the template, so they look like they worked. Nothing in
  // typecheck, svelte-check or the test suite sees it.
  const orchestration = $derived.by(() => {
    if (!browser || !account) return null;
    const limit = shown;
    const status = withStatus;
    const id = userId;
    return account.then((result) => {
      const page = result?.trainings.charges?.unmatched.slice(0, limit) ?? [];
      if (!page.length) return null;
      // `unmatched` is newest first, so the last row on screen is the oldest one to look up.
      return fetchTrainingOrchestration(id, status, page[page.length - 1].date).then((r) => {
        if (!r.reachable) throw new Error('unreachable');
        return r;
      });
    });
  });

  // Orchestrator statuses are lowercase, unlike `statusVariant`'s. `expired` is a failure, not an
  // ordinary outcome.
  const statusBadge = (status: string) =>
    ['failed', 'canceled', 'expired'].includes(status)
      ? ('destructive' as const)
      : ('secondary' as const);

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

{#snippet rows(charges: UnmatchedCharges, recovered: TrainingOrchestration | null)}
  <ul class="space-y-1 text-sm">
    {#each charges.unmatched.slice(0, shown) as charge (charge.id)}
      {@const run = recovered?.runs[charge.id]}
      <li class="border-b border-dark-4 pb-1 last:border-0">
        <div class="flex flex-wrap items-baseline gap-x-3">
          <span class="text-dark-0">{dateTime(charge.date)}</span>
          <span class="text-xs text-dark-2">{num(charge.buzz)} buzz</span>
          {#if run?.status}
            <Badge variant={statusBadge(run.status)}>{run.status}</Badge>
          {/if}
          {#if run && run.refunded === null}
            <span
            class="text-xs text-dark-2"
            title="This charge predates the workflow ids refunds are matched on, so the ledger cannot be joined to it."
          >
            refund unknown
          </span>
          {:else if run?.refunded}
            <span class="text-xs text-amber-300">
              {run.refunded >= charge.buzz
                ? 'refunded in full'
                : `${num(run.refunded)} of ${num(charge.buzz)} refunded`}
            </span>
          {/if}
          {#if run?.epochs === null && run?.jobTypes.length}
            <Badge variant="destructive">no training job ran</Badge>
          {/if}
        </div>
        {#if run}
          <div
          class="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-3 break-all text-xs text-dark-2"
        >
            {#if run.engine}<span>{run.engine}</span>{/if}
            {#each run.baseModels as base (base.modelVersionId)}
              <a
                href="{civitaiUrl}/models/{base.modelId}?modelVersionId={base.modelVersionId}"
                target="_blank"
                rel="noreferrer"
                class={LINK_CLASS}
              >
                {base.modelName ?? `model ${base.modelId}`}{base.baseModel
                  ? ` (${base.baseModel})`
                  : ''}
              </a>
            {/each}
            {#if run.epochs !== null}<span>{num(run.epochs)} epochs</span>{/if}
            {#if run.cost !== null}<span>{num(run.cost)} buzz of GPU</span>{/if}
            {#if run.provider}<span>{run.provider}</span>{/if}
            {#if run.failureClass}<span class="text-amber-300">{run.failureClass}</span>{/if}
            {#if run.lastJobAt}<span>last job {dateTime(run.lastJobAt)}</span>{/if}
          </div>
          {#if run.jobTypes.length}
            <div class="text-xs text-dark-2">
              dispatched {run.jobTypes.map((j) => `${j.count}x ${j.type}`).join(', ')}
            </div>
          {/if}
          {#if run.ambiguous}
            <p class="text-xs text-amber-300">
              Another submission shares this second — the job records cannot be
              split between them, so these figures cover both.
            </p>
          {/if}
        {:else if recovered}
          {#if olderThan(charge.date, recovered.enrichedFrom)}
            <p class="text-xs text-amber-300">
              Not looked up — older than the newest batch of charges one query can carry.
            </p>
          {:else}
            <p class="text-xs text-dark-2">
              Nothing in the orchestration history either — job records reach back to 2024-05
              and run status to about three months.
            </p>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
  {#if charges.unmatched.length > shown}
    <button
      type="button"
      class="mt-2 text-sm {LINK_CLASS}"
      onclick={() => (shown += PAGE)}
    >
      Load {Math.min(PAGE, charges.unmatched.length - shown)} more ({num(
        charges.unmatched.length - shown
      )} left)
    </button>
  {/if}
{/snippet}

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
          Runs with no surviving record ({charges.unmatched.length > shown
            ? `${num(Math.min(shown, charges.unmatched.length))} of ${num(charges.unmatched.length)}`
            : num(charges.unmatched.length)})
        </h4>
        <p class="mb-2 text-xs text-dark-2">
          Charged for, so they ran. A training whose model is still a draft 30 days later is deleted
          outright — version, dataset and results together — and the orchestrator flushes on the same
          30-day horizon, so what is below is reconstructed from ClickHouse's copy. The name the account
          gave the model is not in it.
        </p>
        {#await orchestration}
          <p class="mb-2 text-xs text-dark-2">Reading the orchestration history…</p>
          {@render rows(charges, null)}
        {:then recovered}
          {#if recovered && !withStatus}
            <button type="button" class="mb-2 text-xs {LINK_CLASS}" onclick={() => (withStatus = true)}>
              Also read each run's final status — a slower query, up to {Math.max(
                1,
                Math.min(100, Math.round(spanDays(charges.unmatched.slice(0, shown))))
              )} days of workflow history
            </button>
          {/if}
          {#if recovered?.truncated}
            <p class="mb-2 text-xs text-amber-300">
              Only charges back to {dateTime(recovered.enrichedFrom)} were looked up — this account has
              more training charges than one query can carry.
            </p>
          {/if}
          {@render rows(charges, recovered)}
        {:catch}
          <p class="mb-2 text-xs text-red-300">
            Could not read the orchestration history — this says nothing about whether the runs are
            recorded there.
          </p>
          {#if withStatus}
            <!-- The toggle that turned this on renders only in the resolved branch, so without this
                 a failed status query leaves no way back short of a reload. -->
            <button
              type="button"
              class="mb-2 text-xs {LINK_CLASS}"
              onclick={() => (withStatus = false)}
            >
              Retry without the status query
            </button>
          {/if}
          {@render rows(charges, null)}
        {/await}
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

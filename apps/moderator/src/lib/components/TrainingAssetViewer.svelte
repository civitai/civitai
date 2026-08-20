<script lang="ts">
  import { browser } from '$app/environment';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Progress } from '@civitai/ui/components/ui/progress/index.js';
  import { Spinner } from '@civitai/ui/components/ui/spinner/index.js';
  import TrainingAssetGrid from './TrainingAssetGrid.svelte';
  import {
    loadTrainingAssets,
    revokeTrainingAssets,
    type TrainingProgress,
  } from '$lib/training-zip';

  let {
    versionId,
    columns = 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
    enabled = true,
  }: {
    versionId: number;
    columns?: string;
    /** The sheet only wants the download to start once it is open. */
    enabled?: boolean;
  } = $props();

  // Part of the derived key, so bumping it rebuilds the job. The sheet recovers by closing and
  // reopening; the detail page has no such lever and previously needed a full reload.
  let attempt = $state(0);

  // The controller travels WITH the promise so the cleanup below aborts the run it belongs to, not
  // whichever one happens to be current when the component tears down.
  const job = $derived.by(() => {
    attempt;
    if (!browser || !enabled) return null;
    const controller = new AbortController();
    // Carried ON the job so a superseded run's late callback cannot paint over the current one.
    const reported = $state<{ current: TrainingProgress | null }>({ current: null });
    const promise = loadTrainingAssets(versionId, {
      signal: controller.signal,
      onProgress: (p) => (reported.current = p),
    });
    return { controller, promise, reported };
  });

  $effect(() => {
    const current = job;
    return () => {
      // Abort first: `loadTrainingAssets` releases its own object URLs when it throws, so a cancelled
      // run cleans up after itself and the resolved path is the only one that hands them over.
      current?.controller.abort();
      current?.promise.then(revokeTrainingAssets).catch(() => {});
    };
  });

  const progress = $derived(job?.reported.current ?? null);

  const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

  const status = $derived.by(() => {
    if (!progress) return 'Starting…';
    if (progress.phase === 'downloading')
      return progress.totalBytes
        ? `Downloading ${mb(progress.receivedBytes)} of ${mb(progress.totalBytes)}`
        : `Downloading ${mb(progress.receivedBytes)}`;
    return `Unpacking ${progress.done} of ${progress.total} files`;
  });

  const percent = $derived(
    progress?.phase === 'downloading' && progress.totalBytes
      ? Math.round((progress.receivedBytes / progress.totalBytes) * 100)
      : progress?.phase === 'unpacking' && progress.total
        ? Math.round((progress.done / progress.total) * 100)
        : null
  );
</script>

{#if job}
  {#await job.promise}
    <div class="flex items-center gap-3 py-6">
      <Spinner class="size-4 text-dark-2" />
      <div class="min-w-0">
        <p class="text-sm text-dark-0">{status}</p>
        {#if percent !== null}
          <Progress value={percent} max={100} class="mt-1.5 h-1 w-56" />
        {/if}
      </div>
    </div>
  {:then assets}
    <TrainingAssetGrid {assets} {columns} />
  {:catch e}
    <div class="flex flex-wrap items-center gap-3 py-6">
      <p class="text-sm text-red-300">{e.message}</p>
      <Button size="sm" variant="outline" onclick={() => attempt++}>Try again</Button>
    </div>
  {/await}
{/if}

<script lang="ts">
  import { IconAlertTriangle, IconPlus } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { remixFromRun } from '$lib/reuse';
  import ModelCodeBadge from '$lib/components/ModelCodeBadge.svelte';
  import RunStateBadge from '$lib/components/RunStateBadge.svelte';
  import SampleGrid from '$lib/components/SampleGrid.svelte';
  import GradientTile from '$lib/components/GradientTile.svelte';
  import type { TrainingRow } from '$lib/data/trainingRows';

  let { rows, onNew }: { rows: TrainingRow[]; onNew: () => void } = $props();

  // Remix / Retry reuse a run's dataset. Track which card is in flight and surface a failure inline, so the
  // button never looks like a dead click (it navigates away on success).
  let remixingId = $state<string | null>(null);
  let remixError = $state('');
  async function remix(workflowId: string) {
    if (remixingId) return;
    remixingId = workflowId;
    remixError = '';
    try {
      await remixFromRun(workflowId);
    } catch (err) {
      remixError = err instanceof Error ? err.message : 'Could not reuse that dataset.';
    } finally {
      remixingId = null;
    }
  }
</script>

<section class="flex flex-col gap-5">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h2 class="m-0 text-xl font-semibold text-white">My trainings</h2>
      <p class="mt-1 text-sm text-dark-2">
        Every run stays here — open one for live progress or results, train it further, or start
        something new.
      </p>
    </div>
    <Button onclick={onNew}><IconPlus size={15} stroke={2} class="mr-1.5 inline" />New training</Button>
  </div>

  {#if remixError}
    <p
      class="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 font-mono text-[11px] text-red-400"
    >
      {remixError}
    </p>
  {/if}

  {#if rows.length === 0}
    <div class="rounded-xl border border-dashed border-dark-4 bg-dark-6 p-10 text-center">
      <p class="text-sm text-dark-2">No trainings yet.</p>
      <Button class="mt-3" onclick={onNew}>
        <IconPlus size={15} stroke={2} class="mr-1.5 inline" />Start your first training
      </Button>
    </div>
  {:else}
  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {#each rows as r (r.workflowId ?? r.name)}
      <div
        class="group relative flex flex-col overflow-hidden rounded-xl border border-dark-4 bg-dark-6 transition-colors hover:border-dark-3"
      >
        <!-- Stretched link: the whole card opens the run. Sits under the action buttons (z-index below), so
             clicking the title/samples navigates while the buttons keep their own behaviour. -->
        {#if r.workflowId}
          <a href={`/${r.workflowId}`} class="absolute inset-0 z-[1]" aria-label={`Open ${r.name}`}></a>
        {/if}

        <div class="flex items-center gap-3 border-b border-dark-4 p-3.5">
          <ModelCodeBadge code={r.code} size="lg" />
          <div class="min-w-0">
            <div class="truncate text-sm font-bold text-dark-0 transition-colors group-hover:text-white">
              {r.name}
            </div>
            <div class="truncate font-mono text-[11px] text-dark-2">
              {r.base}{r.sub ? ` · ${r.sub}` : ''}
            </div>
          </div>
          <RunStateBadge state={r.state} class="ml-auto" />
        </div>

        <div class="p-3.5">
          {#if r.state === 'training'}
            <div
              class="h-1.5 overflow-hidden rounded-full bg-dark-7"
              role="progressbar"
              aria-label="Training progress"
              aria-valuenow={r.progressPct > 0 ? r.progressPct : undefined}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              {#if r.progressPct > 0}
                <div class="h-full bg-buzz" style={`width:${r.progressPct}%`}></div>
              {:else}
                <div class="h-full w-1/3 animate-pulse bg-buzz/60"></div>
              {/if}
            </div>
            <div class="mt-2 font-mono text-[11px] text-dark-2">{r.progress}</div>
            {#if r.sampleUrls.length > 0}
              <div class="mt-3"><SampleGrid urls={r.sampleUrls} cols={4} isVideo={r.isVideo} /></div>
            {/if}
          {:else if r.state === 'failed'}
            <div
              class="flex items-center gap-2 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-4 text-[11px] text-dark-2"
            >
              <IconAlertTriangle size={15} stroke={2} class="shrink-0 text-red-400" /> This run didn't complete.
            </div>
          {:else if r.sampleUrls.length > 0}
            <SampleGrid urls={r.sampleUrls} cols={4} isVideo={r.isVideo} />
          {:else}
            <div class="grid grid-cols-4 gap-1.5">
              {#each Array(4) as _, i (i)}
                <GradientTile index={r.code.length + i} />
              {/each}
            </div>
          {/if}
        </div>

        <div class="relative z-[2] mt-auto flex flex-wrap gap-2 px-3.5 pb-3.5">
          {#if r.state !== 'failed'}
            <Button
              variant="outline"
              size="sm"
              disabled={remixingId === r.workflowId}
              onclick={() => r.workflowId && remix(r.workflowId)}
            >
              {remixingId === r.workflowId ? 'Loading…' : 'Remix'}
            </Button>
          {/if}
          {#if r.state === 'failed'}
            <Button
              variant="outline"
              size="sm"
              disabled={remixingId === r.workflowId}
              onclick={() => r.workflowId && remix(r.workflowId)}
            >
              {remixingId === r.workflowId ? 'Loading…' : 'Retry'}
            </Button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
  {/if}
</section>

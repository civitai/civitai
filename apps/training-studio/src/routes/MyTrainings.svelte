<script lang="ts">
  import { goto } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ModelCodeBadge from '$lib/components/ModelCodeBadge.svelte';
  import RunStateBadge from '$lib/components/RunStateBadge.svelte';
  import SampleGrid from '$lib/components/SampleGrid.svelte';
  import GradientTile from '$lib/components/GradientTile.svelte';
  import type { TrainingRow } from '$lib/data/trainingRows';

  let { rows, onNew }: { rows: TrainingRow[]; onNew: () => void } = $props();
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
    <Button onclick={onNew}>+ New training</Button>
  </div>

  {#if rows.length === 0}
    <div class="rounded-md border border-dashed border-dark-4 bg-dark-6 p-10 text-center">
      <p class="text-sm text-dark-2">No trainings yet.</p>
      <Button class="mt-3" onclick={onNew}>+ Start your first training</Button>
    </div>
  {:else}
  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {#each rows as r (r.workflowId ?? r.name)}
      <div class="overflow-hidden rounded-md border border-dark-4 bg-dark-6">
        <div class="flex items-center gap-3 border-b border-dark-4 p-3.5">
          <ModelCodeBadge code={r.code} size="lg" />
          <div class="min-w-0">
            <div class="truncate text-sm font-bold text-dark-0">{r.name}</div>
            <div class="truncate font-mono text-[11px] text-dark-2">
              {r.base}{r.sub ? ` · ${r.sub}` : ''}
            </div>
          </div>
          <RunStateBadge state={r.state} class="ml-auto" />
        </div>

        <div class="p-3.5">
          {#if r.state === 'training'}
            <div class="h-1.5 overflow-hidden rounded-full bg-dark-7">
              {#if r.progressPct > 0}
                <div class="h-full bg-[#f59f00]" style={`width:${r.progressPct}%`}></div>
              {:else}
                <div class="h-full w-1/3 animate-pulse bg-[#f59f00]/60"></div>
              {/if}
            </div>
            <div class="mt-2 font-mono text-[11px] text-dark-2">{r.progress}</div>
          {:else if r.state === 'failed'}
            <div
              class="flex items-center gap-2 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-4 text-[11px] text-dark-2"
            >
              <span>⚠️</span> This run didn't complete.
            </div>
          {:else if r.sampleUrls.length > 0}
            <SampleGrid urls={r.sampleUrls} cols={4} />
          {:else}
            <div class="grid grid-cols-4 gap-1.5">
              {#each Array(4) as _, i (i)}
                <GradientTile index={r.code.length + i} />
              {/each}
            </div>
          {/if}

          <div class="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!r.workflowId}
              onclick={() => r.workflowId && goto(`/${r.workflowId}`)}
            >
              Open
            </Button>
            {#if r.state === 'ready' || r.state === 'published'}
              <Button variant="outline" size="sm">Generate</Button>
            {/if}
            {#if r.state === 'ready'}
              <Button variant="outline" size="sm">Train further</Button>
            {/if}
            {#if r.state !== 'failed'}
              <Button variant="outline" size="sm">Remix</Button>
            {/if}
            {#if r.state === 'failed'}
              <Button variant="outline" size="sm">Retry</Button>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>
  {/if}
</section>

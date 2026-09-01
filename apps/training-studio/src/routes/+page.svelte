<script lang="ts">
  import MyTrainings from './MyTrainings.svelte';
  import TrainingFlow from './TrainingFlow.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let view = $state<'list' | 'flow'>('list');
</script>

<header class="mb-6 flex items-center justify-between gap-3">
  <div class="flex items-center gap-2.5">
    <span class="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-sky-700 to-sky-400 text-sm font-bold text-white">
      C
    </span>
    <div class="font-semibold leading-tight text-white">
      Training Studio
      <span class="block font-mono text-[10px] uppercase tracking-widest text-dark-2">Beta</span>
    </div>
  </div>
  <span class="font-mono text-sm text-dark-2">
    {#if data.username}Signed in as <span class="text-dark-0">{data.username}</span>{/if}
  </span>
</header>

{#if view === 'list'}
  <MyTrainings rows={data.rows} onNew={() => (view = 'flow')} onOpen={() => (view = 'flow')} />
{:else}
  <TrainingFlow onExit={() => (view = 'list')} />
{/if}

<script lang="ts">
  import { page } from '$app/state';
  import { cn } from '@civitai/ui/utils.js';
  import { urlWith } from '$lib/url';
  import AppealFilterBar from './AppealFilterBar.svelte';
  import AppealTriage from './AppealTriage.svelte';
  import RedetectedQueue from './RedetectedQueue.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const views = [
    { value: 'appeals', label: 'Appeals' },
    { value: 'redetected', label: 'Re-detected' },
  ] as const;
  // Each view pages and selects on its own, so switching drops both.
  const viewHref = (value: string) =>
    urlWith(page.url, {
      view: value === 'appeals' ? null : value,
      page: null,
      appeal: null,
    });
</script>

<div class="flex flex-col gap-3 px-6 pb-4 lg:h-[calc(100svh-3rem)]">
  <div class="flex flex-wrap items-center gap-4">
    <h1 class="m-0 text-xl font-semibold text-white">Model Flag Appeals</h1>
    <nav
      aria-label="Queue"
      class="inline-flex gap-0.5 rounded-lg border border-dark-4 bg-dark-7 p-0.5"
    >
      {#each views as view (view.value)}
        <a
          href={viewHref(view.value)}
          aria-current={data.view === view.value ? 'true' : undefined}
          class={cn(
            'rounded-md px-3 py-1.5 text-sm transition-colors',
            data.view === view.value
              ? 'bg-blue-600 font-medium text-white'
              : 'text-dark-0 hover:bg-dark-5 hover:text-white'
          )}
        >
          {view.label}
        </a>
      {/each}
    </nav>
  </div>
  {#if data.view === 'redetected'}
    <RedetectedQueue {data} {form} />
  {:else}
    <AppealFilterBar filters={data.appealFilters} facets={data.facets} q={data.q} />
    <AppealTriage {data} {form} />
  {/if}
</div>

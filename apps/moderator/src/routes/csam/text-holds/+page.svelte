<script lang="ts">
  import { page } from '$app/state';
  import { cn } from '@civitai/ui/utils.js';
  import { urlWith } from '$lib/url';
  import CsamHoldTriage from './CsamHoldTriage.svelte';
  import { CSAM_HOLD_ENTITY_TYPES, entityLabel } from './hold-entity';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const filters = $derived([
    { value: null, label: 'All' },
    ...CSAM_HOLD_ENTITY_TYPES.map((value) => ({ value, label: entityLabel(value) })),
  ]);
</script>

<div class="flex flex-col gap-3 px-6 pb-4 lg:h-[calc(100svh-3rem)]">
  <h1 class="m-0 text-xl font-semibold text-white">CSAM text holds</h1>
  <nav
    aria-label="Entity type"
    class="inline-flex flex-wrap gap-0.5 self-start rounded-lg border border-dark-4 bg-dark-7 p-0.5"
  >
    {#each filters as filter (filter.value ?? 'all')}
      {@const active = data.entityType === filter.value}
      <a
        href={urlWith(page.url, { entityType: filter.value, page: null, hold: null })}
        data-sveltekit-noscroll
        aria-current={active ? 'true' : undefined}
        class={cn(
          'rounded-md px-3 py-1.5 text-sm transition-colors',
          active ? 'bg-blue-600 font-medium text-white' : 'text-dark-0 hover:bg-dark-5 hover:text-white'
        )}
      >
        {filter.label}
      </a>
    {/each}
  </nav>
  <CsamHoldTriage {data} {form} canDismiss={data.grants['csam.report.file'] === true} />
</div>

<script lang="ts">
  import { page } from '$app/state';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { urlWith } from '$lib/url';
  import CsamHoldTriage from './CsamHoldTriage.svelte';
  import { CSAM_HOLD_ENTITY_TYPES, entityLabel } from './hold-entity';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const ALL = 'all';

  const filterHref = (entityType: string | null) =>
    urlWith(page.url, { entityType, page: null, hold: null });

  const filters = $derived([
    { value: ALL, label: 'All', href: filterHref(null) },
    ...CSAM_HOLD_ENTITY_TYPES.map((value) => ({
      value,
      label: entityLabel(value),
      href: filterHref(value),
    })),
  ]);
</script>

<div class="flex flex-col gap-3 px-6 pb-4 lg:h-[calc(100svh-3rem)]">
  <h1 class="m-0 text-xl font-semibold text-white">CSAM text holds</h1>
  <nav aria-label="Entity type" data-sveltekit-noscroll>
    <LinkTabs items={filters} active={data.entityType ?? ALL} />
  </nav>
  <CsamHoldTriage {data} {form} canDismiss={data.grants['csam.report.file'] === true} />
</div>

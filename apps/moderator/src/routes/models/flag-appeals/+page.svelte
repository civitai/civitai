<script lang="ts">
  import AppealFilterBar from './AppealFilterBar.svelte';
  import AppealTriage from './AppealTriage.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="flex flex-col gap-3 px-6 pb-4 lg:h-[calc(100svh-3rem)]">
  <h1 class="m-0 text-xl font-semibold text-white">Model Flag Appeals</h1>
  <AppealFilterBar filters={data.appealFilters} facets={data.facets} q={data.q} />
  <AppealTriage {data} {form} />
</div>

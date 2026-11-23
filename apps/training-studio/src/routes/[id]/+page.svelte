<script lang="ts">
  import { refresh } from '$lib/host';
  import StudioHeader from '$lib/components/StudioHeader.svelte';
  import { useElementsUi } from '$lib/elements-ui';
  import RunDetail from '../RunDetail.svelte';
  import RunDetailElements from '../RunDetailElements.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const elementsUi = useElementsUi();
  const Run = $derived(elementsUi() ? RunDetailElements : RunDetail);
</script>

<StudioHeader username={data.username} image={data.image} logoutUrl={data.logoutUrl} buzz={data.buzz} />

<Run detail={data.detail} onRefresh={() => refresh('app:training-detail')} />

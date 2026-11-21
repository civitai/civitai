<script lang="ts">
  import { refresh } from '$lib/host';
  import StudioHeader from '$lib/components/StudioHeader.svelte';
  import RunDetail from '../RunDetail.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<StudioHeader username={data.username} image={data.image} logoutUrl={data.logoutUrl} buzz={data.buzz} />

<RunDetail detail={data.detail} onRefresh={() => refresh('app:training-detail')} />

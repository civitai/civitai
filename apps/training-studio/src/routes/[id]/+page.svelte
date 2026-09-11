<script lang="ts">
  import { refresh } from '$lib/host';
  import AppHeader from '$lib/components/AppHeader.svelte';
  import RunDetail from '../RunDetail.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<AppHeader username={data.username} image={data.image} logoutUrl={data.logoutUrl} buzz={data.buzz} />

<RunDetail detail={data.detail} onRefresh={() => refresh('app:training-detail')} />

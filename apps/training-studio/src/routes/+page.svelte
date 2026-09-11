<script lang="ts">
  import { navigate } from '$lib/host';
  import AppHeader from '$lib/components/AppHeader.svelte';
  import MyTrainings from './MyTrainings.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<AppHeader username={data.username} image={data.image} logoutUrl={data.logoutUrl} buzz={data.buzz} />
<MyTrainings rows={data.rows} onNew={() => navigate({ view: 'new' })} />

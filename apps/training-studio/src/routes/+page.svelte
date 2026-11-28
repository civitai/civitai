<script lang="ts">
  import { navigate } from '$lib/host';
  import StudioHeader from '$lib/components/StudioHeader.svelte';
  import { useElementsUi } from '$lib/elements-ui';
  import MyTrainings from './MyTrainings.svelte';
  import MyTrainingsElements from './MyTrainingsElements.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const useElements = useElementsUi();
  const List = $derived(useElements() ? MyTrainingsElements : MyTrainings);
</script>

<StudioHeader username={data.username} image={data.image} logoutUrl={data.logoutUrl} buzz={data.buzz} />
<List rows={data.rows} onNew={() => navigate({ view: 'new' })} />

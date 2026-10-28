<script lang="ts">
  import TicketDetail from '../../TicketDetail.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<TicketDetail {data} />

<script lang="ts">
  import TicketList from '../TicketList.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<header class="page-header">
  <h1>Support tickets</h1>
  <p class="text-dark-2">Live tickets that moderation does not handle.</p>
</header>

<TicketList tickets={data.tickets} detailBase="/tickets/support" canSeeEmail={data.canSeeEmail} />

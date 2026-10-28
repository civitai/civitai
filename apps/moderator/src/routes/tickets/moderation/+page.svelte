<script lang="ts">
  import TicketList from '../TicketList.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<header class="page-header">
  <h1>Moderation tickets</h1>
  <p class="text-dark-2">Live tickets about appeals, bans, restrictions and moderator decisions.</p>
</header>

<TicketList tickets={data.tickets} detailBase="/tickets/moderation" canSeeEmail={data.canSeeEmail} />

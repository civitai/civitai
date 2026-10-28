<script lang="ts">
  import TicketTable from './TicketTable.svelte';
  import type { TicketListResult } from '$lib/server/tickets/list';

  let {
    tickets,
    detailBase,
    canSeeEmail,
  }: { tickets: Promise<TicketListResult>; detailBase: string; canSeeEmail: boolean } = $props();
</script>

{#await tickets}
  <p class="text-dark-2">Reading live tickets from Freshdesk…</p>
{:then result}
  {#if result.status === 'ok'}
    <TicketTable {result} {detailBase} showEmail={canSeeEmail} />
  {:else}
    <p class="rounded-lg border border-red-800 bg-dark-6 p-3 text-sm text-red-400">
      Could not read tickets: {result.reason}
    </p>
  {/if}
{:catch}
  <p class="rounded-lg border border-red-800 bg-dark-6 p-3 text-sm text-red-400">
    Could not read tickets.
  </p>
{/await}

<script lang="ts">
  import { browser } from '$app/environment';
  import { fetchJson } from '$lib/fetch-json';
  import { SSR_PENDING } from '$lib/ssr-pending';
  import AuditTimeline from './AuditTimeline.svelte';
  import type { AuditRow } from './audit';

  let { itemId }: { itemId: number } = $props();

  const history = $derived(
    browser
      ? fetchJson<{ changes: AuditRow[]; nextBefore: number | null }>(
          `/knights-of-new-order/shop/history?item=${itemId}`
        )
      : SSR_PENDING
  );
</script>

{#await history}
  <p class="text-sm text-dark-2">Loading…</p>
{:then { changes, nextBefore }}
  {#if !changes.length}
    <p class="text-sm text-dark-2">No changes recorded for this item.</p>
  {:else}
    <AuditTimeline rows={changes} />
    {#if nextBefore !== null}
      <p class="mt-4 text-xs text-dark-2">Showing the latest {changes.length} changes.</p>
    {/if}
  {/if}
{:catch}
  <p class="text-sm text-red-300">Could not load this item's history.</p>
{/await}

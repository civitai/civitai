<script lang="ts">
  import { keepLast } from '$lib/keep-last.svelte';
  import type { AccountLinks } from '$lib/linked-accounts';
  import LinkedAccountsList from './LinkedAccountsList.svelte';

  let { links, accountId }: { links: Promise<AccountLinks> | null; accountId: number } = $props();

  // A refetch after an edit elsewhere on the page must not unmount the list: it holds the
  // moderator's ticks.
  const last = keepLast(() => links);
</script>

{#if last.value}
  <div class="mb-4">
    <LinkedAccountsList result={last.value} {accountId} />
    {#if last.loading}
      <p class="mt-2 text-xs text-dark-2">Refreshing…</p>
    {:else if last.failed}
      <p class="mt-2 text-xs text-red-300">Refresh failed; showing the last answer.</p>
    {/if}
  </div>
{:else if last.failed}
  <p class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5 text-sm text-red-300">
    Could not load linked accounts.
  </p>
{:else if links}
  <p class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5 text-sm text-dark-2">
    Checking linked accounts…
  </p>
{/if}

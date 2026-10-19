<script lang="ts">
  import type { LinkedAccounts } from '$lib/linked-accounts';
  import LinkedAccountsList from './LinkedAccountsList.svelte';

  let { linked, accountId }: { linked: Promise<LinkedAccounts> | null; accountId: number } = $props();
</script>

<div class="mb-4">
  {#if linked}
    {#await linked}
      <p class="rounded-xl border border-dark-4 bg-dark-6 p-5 text-sm text-dark-2">
        Checking linked accounts…
      </p>
    {:then result}
      <LinkedAccountsList {result} {accountId} />
    {:catch}
      <p class="rounded-xl border border-dark-4 bg-dark-6 p-5 text-sm text-red-300">
        Could not load linked accounts.
      </p>
    {/await}
  {/if}
</div>

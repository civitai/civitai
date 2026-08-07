<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { dateTime } from '$lib/format';
  import type { Account } from './user-account';
  import ListCard from './ListCard.svelte';

  let { account }: { account: Promise<Account> | null } = $props();
</script>

{#await account}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">Loading notifications…</p>
  </div>
{:then result}
  {#if result?.notifications === null}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <h3 class="mb-3 text-sm font-semibold text-white">Notifications</h3>
      <p class="text-sm text-amber-300">Notifications service unavailable.</p>
    </div>
  {:else if result}
    {@const notifications = result.notifications}
    <ListCard
      title="Notifications sent"
      total={notifications.length}
      shown={15}
      hint="What the site has told this user — context for “I was never warned”."
    >
      {#snippet children(limit)}
        <ul class="space-y-1 text-sm">
          {#each notifications.slice(0, limit) as n (n.id)}
            <li class="flex flex-wrap items-baseline gap-x-2">
              <span class="text-dark-0">{n.type}</span>
              <Badge variant="secondary">{n.category}</Badge>
              {#if !n.read}<span class="text-xs text-dark-2">unread</span>{/if}
              <span class="text-xs text-dark-2">{dateTime(n.createdAt)}</span>
            </li>
          {/each}
        </ul>
      {/snippet}
    </ListCard>
  {/if}
{:catch}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-red-300">Could not load notifications.</p>
  </div>
{/await}

<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { Account } from './user-account';
  import ListCard from './ListCard.svelte';

  let {
    account,
    civitaiUrl,
  }: { account: Promise<Account> | null; civitaiUrl: string } = $props();

  const bountyUrl = (bountyId: number) => `${civitaiUrl}/bounties/${bountyId}`;
</script>

<section class="mb-4 grid gap-4 lg:grid-cols-2">
  {#await account}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-dark-2">Loading bounties…</p>
    </div>
  {:then result}
    {#if result}
      <ListCard
        title="Bounties funded"
        total={result.bounties.items.length} capped={result.bounties.truncated}
        hint="Created by this user, with the total pledged across all benefactors."
      >
        {#snippet children(limit)}
          <ul class="space-y-1 text-sm">
            {#each result.bounties.items.slice(0, limit) as b (b.id)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <a href={bountyUrl(b.id)} target="_blank" rel="noreferrer" class="truncate {LINK_CLASS}">
                  {b.name}
                </a>
                <span class="tabular-nums text-dark-0">{num(b.unitAmount)} buzz</span>
                {#if b.complete}<Badge variant="secondary">complete</Badge>{/if}
                <span class="text-xs text-dark-2">{dateTime(b.createdAt)}</span>
              </li>
            {/each}
          </ul>
        {/snippet}
      </ListCard>

      <ListCard title="Bounty entries" total={result.bountyEntries.items.length} capped={result.bountyEntries.truncated}>
        {#snippet children(limit)}
          <ul class="space-y-1 text-sm">
            {#each result.bountyEntries.items.slice(0, limit) as e (e.id)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <a
                  href={bountyUrl(e.bountyId)}
                  target="_blank"
                  rel="noreferrer"
                  class="truncate {LINK_CLASS}"
                >
                  {e.bountyName}
                </a>
                <span class="text-xs text-dark-2">{dateTime(e.createdAt)}</span>
              </li>
            {/each}
          </ul>
        {/snippet}
      </ListCard>
    {/if}
  {:catch}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-red-300">Could not load bounties.</p>
    </div>
  {/await}
</section>

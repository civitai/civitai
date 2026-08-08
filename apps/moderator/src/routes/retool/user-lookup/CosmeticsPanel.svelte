<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import type { Account } from './user-account';
  import ListCard from './ListCard.svelte';

  let { account }: { account: Promise<Account> | null } = $props();
</script>

{#await account}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">Loading cosmetics…</p>
  </div>
{:then result}
  {#if result}
    <ListCard title="Cosmetics" total={result.cosmetics.items.length} capped={result.cosmetics.truncated} shown={10}>
      {#snippet children(limit)}
        <ul class="space-y-1 text-sm">
          {#each result.cosmetics.items.slice(0, limit) as c (c.key)}
            <li class="flex flex-wrap items-baseline gap-x-2">
              <span class="text-dark-0">{c.name}</span>
              <Badge variant="secondary">{c.type}</Badge>
              {#if c.equipped}<span class="text-xs text-dark-2">equipped</span>{/if}
            </li>
          {/each}
        </ul>
      {/snippet}
    </ListCard>
  {/if}
{:catch}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-red-300">Could not load cosmetics.</p>
  </div>
{/await}

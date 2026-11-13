<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { dateTime, num } from '$lib/format';
  import type { Signals } from './signals';
  import ListCard from './ListCard.svelte';

  let { signals }: { signals: Promise<Signals> | null } = $props();
</script>

{#if signals}
  <div class="mb-4">
    {#await signals}
      <p class="rounded-xl border border-dark-4 bg-dark-6 p-5 text-sm text-dark-2">
        Checking addresses…
      </p>
    {:then result}
      <ListCard
        title="Addresses"
        total={result.ips.addresses.length}
        shown={12}
        hint="The 100 most recently used, internal traffic and ban events excluded."
        empty="No activity recorded."
      >
        {#snippet children(limit: number)}
          <ul class="grid gap-x-6 gap-y-1 text-sm lg:grid-cols-2">
            {#each result.ips.addresses.slice(0, limit) as row (`${row.ip}:${row.type}`)}
              <li>
                <div class="flex flex-wrap items-baseline gap-x-2">
                  <code class="text-dark-0">{row.ip}</code>
                  <Badge variant="secondary">{row.type}</Badge>
                  <span class="text-xs text-dark-2">{num(row.events)} events, all time</span>
                </div>
                <div class="text-xs text-dark-2">
                  first {dateTime(row.first)} · last {dateTime(row.last)}
                </div>
              </li>
            {/each}
          </ul>
        {/snippet}
      </ListCard>
    {:catch}
      <p class="rounded-xl border border-dark-4 bg-dark-6 p-5 text-sm text-red-300">
        Could not load addresses.
      </p>
    {/await}
  </div>
{/if}

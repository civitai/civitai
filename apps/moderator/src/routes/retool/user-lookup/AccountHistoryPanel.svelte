<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import type { Signals } from './signals';
  import ListCard from './ListCard.svelte';

  let { signals }: { signals: Promise<Signals> | null } = $props();
</script>

{#if signals}
  <div class="mb-4">
    {#await signals}
      <p class="rounded-xl border border-dark-4 bg-dark-6 p-5 text-sm text-dark-2">
        Loading account history…
      </p>
    {:then result}
      <ListCard
        title="Account history"
        total={result.events.length}
        shown={12}
        empty="No recorded account events."
      >
        {#snippet children(limit: number)}
          <ul class="space-y-1 text-sm">
            {#each result.events.slice(0, limit) as e (e.key)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <Badge variant="secondary">{e.type}</Badge>
                <span class="text-xs text-dark-2">{dateTime(e.time)}</span>
                {#if e.actorId}
                  <span class="text-xs text-dark-2">
                    by <a href="?q={e.actorId}" class={LINK_CLASS}>{e.actor ?? `#${e.actorId}`}</a>
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {/snippet}
      </ListCard>
    {:catch}
      <p class="rounded-xl border border-dark-4 bg-dark-6 p-5 text-sm text-red-300">
        Could not load account history.
      </p>
    {/await}
  </div>
{/if}

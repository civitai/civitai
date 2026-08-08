<script lang="ts">
  import { LINK_CLASS, num } from '$lib/format';
  import type { Account } from './user-account';
  import type { Signals } from './signals';
  import ListCard from './ListCard.svelte';

  let {
    signals,
    account,
    civitaiUrl,
  }: {
    signals: Promise<Signals> | null;
    account: Promise<Account> | null;
    civitaiUrl: string;
  } = $props();
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-3 text-sm font-semibold text-white">Image generation</h3>
  {#await signals}
    <p class="text-sm text-dark-2">Loading generation activity…</p>
  {:then result}
    {#if result}
      <div>
        <div class="text-xl font-semibold tabular-nums text-white">
          {num(result.generation.last24h)}
        </div>
        <div class="text-xs text-dark-2">Jobs in the last 24 hours</div>
      </div>
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load generation activity.</p>
  {/await}
</section>

{#await account then result}
  {#if result}
    <ListCard
      title="Generations of their resources"
      total={result.resourceGenerations.length}
      hint="Last 30 days, most-used first. Concentration or a spike is the farming signal."
    >
      {#snippet children(limit)}
        <ul class="space-y-1 text-sm">
          {#each result.resourceGenerations.slice(0, limit) as g (g.modelVersionId)}
            <li class="flex flex-wrap items-baseline gap-x-2">
              <span class="tabular-nums text-dark-0">{num(g.count)}</span>
              <a
                href="{civitaiUrl}/models/{g.modelId}?modelVersionId={g.modelVersionId}"
                target="_blank"
                rel="noreferrer"
                class="truncate {LINK_CLASS}"
              >
                {g.modelName}
              </a>
            </li>
          {/each}
        </ul>
      {/snippet}
    </ListCard>
  {/if}
{:catch}
  <p class="text-sm text-red-300">Could not load resource generations.</p>
{/await}

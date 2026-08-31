<script lang="ts">
  import { browser } from '$app/environment';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { LINK_CLASS, num } from '$lib/format';
  import type { ResourceGeneration } from './user-account';
  import type { Signals } from './signals';
  import ListCard from './ListCard.svelte';

  let {
    signals,
    userId,
    civitaiUrl,
  }: {
    signals: Promise<Signals> | null;
    userId: number;
    civitaiUrl: string;
  } = $props();

  // Retool's look-back selector. The service always took the parameter; nothing had ever set it, so
  // every account was read at 30 days no matter what the question was.
  const WINDOWS: [string, string][] = [
    ['7', 'Last 7 days'],
    ['30', 'Last 30 days'],
    ['90', 'Last 90 days'],
    ['365', 'Last year'],
  ];
  let days = $state('30');

  const generations = $derived(
    browser
      ? fetch(`/api/user-generations/${userId}?days=${days}`).then(
          (r): Promise<ResourceGeneration[]> => {
            if (!r.ok) throw new Error(String(r.status));
            return r.json();
          }
        )
      : null
  );

  const windowLabel = $derived(WINDOWS.find(([v]) => v === days)?.[1] ?? 'Last 30 days');
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

<!-- The window control sits OUTSIDE the card: ListCard renders its empty state instead of the body
     snippet when there are no rows, so a control nested in there would vanish on exactly the accounts
     where you need to widen the window to find anything. -->
<div class="mb-2 flex justify-end">
  <Select.Root type="single" bind:value={days}>
    <Select.Trigger class="w-44">{windowLabel}</Select.Trigger>
    <Select.Content>
      {#each WINDOWS as [value, label] (value)}
        <Select.Item {value}>{label}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
</div>

{#await generations}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">Loading resource generations…</p>
  </div>
{:then rows}
  {#if rows}
    <ListCard
      title="Generations of their resources"
      total={rows.length}
      hint="Most-used first. Concentration or a spike is the farming signal."
      empty="No generations of this account's resources in the selected window."
    >
      {#snippet children(limit)}
        <ul class="space-y-1 text-sm">
          {#each rows.slice(0, limit) as g (g.modelVersionId)}
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
              <span class="text-xs text-dark-2">{g.versionName ?? `version ${g.modelVersionId}`}</span>
            </li>
          {/each}
        </ul>
      {/snippet}
    </ListCard>
  {/if}
{:catch}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-red-300">Could not load resource generations.</p>
  </div>
{/await}

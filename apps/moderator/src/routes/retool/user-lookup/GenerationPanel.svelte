<script lang="ts">
  import { browser } from '$app/environment';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { LINK_CLASS, num } from '$lib/format';
  import type { ResourceGeneration } from './user-account';
  import type { Signals } from './signals';
  import ListCard from './ListCard.svelte';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';

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
  // every account was read at 30 days no matter what the question was. Two labels each: the trigger
  // shares a line with the card's heading, so it carries the short one and the menu spells it out.
  const WINDOWS: [value: string, label: string, short: string][] = [
    ['7', 'Last 7 days', '7d'],
    ['30', 'Last 30 days', '30d'],
    ['90', 'Last 90 days', '90d'],
    ['365', 'Last year', '1y'],
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

  const windowShort = $derived(WINDOWS.find(([v]) => v === days)?.[2] ?? '30d');

  // Named once: the pending and error branches render the same heading, and a title that drifts
  // between them tells a moderator the card changed identity while it was loading.
  const RESOURCE_TITLE = 'Site-wide use of their resources';
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

<!-- Rendered in all three await branches, not just the resolved one: changing the window re-enters the
     pending branch, and a control that unmounts there takes itself away mid-change — and away for good
     if the refetch then fails. ListCard's `action` slot puts it on the heading row. -->
{#snippet windowSelect()}
  <div class="ml-auto">
    <Select.Root type="single" bind:value={days}>
      <!-- No width class: the trigger is `w-fit`, so a three-character label keeps it small enough to
           stay on the heading's line in a sidebar-width column. -->
      <Select.Trigger size="sm" aria-label="Look-back window">{windowShort}</Select.Trigger>
      <Select.Content>
        {#each WINDOWS as [value, label] (value)}
          <Select.Item {value}>{label}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
{/snippet}

{#await generations}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <div class="mb-3 flex flex-wrap items-end justify-between gap-2">
      <h3 class="text-sm font-semibold text-white">{RESOURCE_TITLE}</h3>
      {@render windowSelect()}
    </div>
    <p class="text-sm text-dark-2">Loading resource generations…</p>
  </div>
{:then rows}
  {#if rows}
    <ListCard
      title={RESOURCE_TITLE}
      total={rows.length}
      hint="Every user's generations with models this account published, its own included — not what this
            account generated. Most-used first. A spike is a lead, not a finding: with no per-user
            breakdown here, a model gaining popularity and an account farming its own look identical."
      empty="Nobody generated with this account's resources in the selected window."
    >
      {#snippet action()}
        {@render windowSelect()}
      {/snippet}
      {#snippet children(limit)}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Resource</TableHead>
              <TableHead class="text-right">Generations</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each rows.slice(0, limit) as g (g.modelVersionId)}
              <TableRow>
                <TableCell class="w-full max-w-0">
                  <a
                    href="{civitaiUrl}/models/{g.modelId}?modelVersionId={g.modelVersionId}"
                    target="_blank"
                    rel="noreferrer"
                    class="block truncate {LINK_CLASS}"
                  >
                    {g.modelName}
                  </a>
                  <span class="block truncate text-xs text-dark-2">
                    {g.versionName ?? `version ${g.modelVersionId}`}
                  </span>
                </TableCell>
                <TableCell class="text-right align-top tabular-nums">{num(g.count)}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/snippet}
    </ListCard>
  {/if}
{:catch}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <div class="mb-3 flex flex-wrap items-end justify-between gap-2">
      <h3 class="text-sm font-semibold text-white">{RESOURCE_TITLE}</h3>
      {@render windowSelect()}
    </div>
    <p class="text-sm text-red-300">Could not load resource generations.</p>
  </div>
{/await}

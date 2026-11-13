<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { previewOdds, type BoxDraft, type RewardInfo } from '$lib/mystery-box';

  let {
    draft,
    rewards,
    teams,
  }: { draft: BoxDraft; rewards: SvelteMap<number, RewardInfo>; teams: string[] } = $props();

  let picked = $state<string | null>(null);
  const team = $derived(picked !== null && teams.includes(picked) ? picked : (teams[0] ?? null));
  const odds = $derived(previewOdds(draft, rewards, team));
  const percent = (p: number) => `${(p * 100).toFixed(p < 0.01 ? 3 : 2)}%`;
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="mb-2 flex items-center justify-between gap-2">
    <h2 class="text-base font-semibold text-white">Odds preview</h2>
    {#if teams.length}
      <Select.Root type="single" bind:value={() => team ?? '', (v) => (picked = v)}>
        <Select.Trigger class="w-36">{team}</Select.Trigger>
        <Select.Content>
          {#each teams as t (t)}
            <Select.Item value={t}>{t}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    {/if}
  </div>
  <p class="mb-3 text-xs text-dark-2">
    For a buyer{team ? ` on ${team}` : ''} who owns none of it, through the draw's own odds. Unsaved
    changes included.
  </p>
  {#if !odds}
    <p class="text-sm text-red-300">The weights can't be computed; see the checklist.</p>
  {:else if odds.tiers.length === 0}
    <p class="text-sm text-dark-2">Nothing to draw yet.</p>
  {:else}
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Tier</TableHead>
          <TableHead>Items</TableHead>
          <TableHead>Chance</TableHead>
          <TableHead>Each</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each odds.tiers as tier (tier.tierId)}
          {@const source = draft.tiers[tier.tierId]}
          <TableRow>
            <TableCell>
              <span class="inline-flex items-center gap-2 text-dark-0">
                <span class="size-2.5 rounded-full" style:background-color={source.color ?? '#9ca3af'}></span>
                {source.name}
              </span>
            </TableCell>
            <TableCell class="text-dark-2">{tier.contentIds.length}</TableCell>
            <TableCell class="text-dark-0">{percent(tier.probability)}</TableCell>
            <TableCell class="text-dark-2">{percent(tier.itemProbability)}</TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
    {#if odds.tiers.length < draft.tiers.length}
      <p class="mt-2 text-xs text-amber-300">
        {draft.tiers.length - odds.tiers.length} tier(s) hold nothing for this buyer and drop out.
      </p>
    {/if}
  {/if}
</section>

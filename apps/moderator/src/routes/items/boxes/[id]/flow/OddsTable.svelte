<script lang="ts">
  import { percent, teamsDiffer, type TeamOdds } from '$lib/box-flow';
  import { num } from '$lib/format';
  import { FALLBACK_TIER_COLOR, teamColor } from './teams';

  let { odds }: { odds: TeamOdds[] } = $props();

  const together = $derived(!teamsDiffer(odds));
  const columns = $derived(together ? odds.slice(0, 1) : odds);
  const label = (entry: TeamOdds) =>
    together
      ? entry.team === null
        ? 'Buyer (no team)'
        : odds.length > 1
          ? `All ${odds.length} teams`
          : entry.team
      : (entry.team ?? 'No team');
</script>

{#if odds[0].tiers.length === 0}
  <p class="text-sm text-dark-2">Add tiers and items to see odds.</p>
{:else}
  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead class="text-xs text-dark-2">
        <tr>
          <th class="py-1 text-left font-medium">Tier</th>
          {#each columns as entry (entry.team ?? '')}
            <th class="px-2 py-1 text-right font-medium whitespace-nowrap">
              {#if !together && entry.team}
                <span class="mr-1 inline-block size-2 rounded-full" style:background-color={teamColor(entry.team)}></span>
              {/if}
              {label(entry)}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each odds[0].tiers as tier, i (tier.tierKey)}
          <tr class="border-t border-dark-4 align-top">
            <td class="py-2">
              <span class="inline-flex items-center gap-2 text-dark-0">
                <span class="size-2.5 rounded-sm" style:background-color={tier.color ?? FALLBACK_TIER_COLOR}></span>
                {tier.name || tier.tierKey}
              </span>
            </td>
            {#each columns as entry (entry.team ?? '')}
              {@const cell = entry.tiers[i]}
              <td class="px-2 py-2 text-right">
                {#if cell.eligible}
                  <span class="text-dark-0">{percent(cell.share)}</span>
                  <span class="block text-xs text-dark-2">
                    {together ? `each ${percent(cell.each)} · ` : ''}{cell.count}
                    {cell.count === 1 ? 'item' : 'items'}
                  </span>
                {:else}
                  <span class="text-red-300">{together ? 'drops out' : '—'}</span>
                  <span class="block text-xs text-dark-2">{together ? 'nothing in it' : 'empty'}</span>
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
        <tr class="border-t border-dark-4 text-dark-2">
          <td class="py-2">Average draw, shelf value{#if odds[0].unpriced}<span class="block text-xs">{odds[0].unpriced} unpriced {odds[0].unpriced === 1 ? 'item' : 'items'} left out</span>{/if}</td>
          {#each columns as entry (entry.team ?? '')}
            <td class="px-2 py-2 text-right">{num(Math.round(entry.avgShelf))} Buzz</td>
          {/each}
        </tr>
      </tbody>
    </table>
  </div>
{/if}

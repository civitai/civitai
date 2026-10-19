<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { percent, teamsDiffer, type TeamOdds } from '$lib/box-flow';
  import { FALLBACK_TIER_COLOR, teamColor } from './teams';

  let { odds, designs, problems }: { odds: TeamOdds[]; designs: number; problems: number } = $props();

  let picked = $state(0);
  const differ = $derived(teamsDiffer(odds));
  const shown = $derived(odds[differ ? picked % odds.length : 0]);
  const live = $derived(shown.tiers.filter((tier) => tier.eligible));
</script>

<div class="flex h-3 gap-0.5 overflow-hidden rounded-full bg-dark-5" role="img" aria-label="Chance of each tier">
  {#each live as tier (tier.tierKey)}
    <i class="block h-full min-w-[3px]" style:width="{tier.share * 100}%" style:background-color={tier.color ?? FALLBACK_TIER_COLOR}></i>
  {/each}
</div>
<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dark-0">
  {#each live as tier (tier.tierKey)}
    <span class="inline-flex items-center gap-1">
      <i class="inline-block size-2 rounded-sm" style:background-color={tier.color ?? FALLBACK_TIER_COLOR}></i>
      {tier.name || tier.tierKey}
      <b class="font-semibold text-white">{percent(tier.share)}</b>
    </span>
  {:else}
    <span class="text-dark-2">No odds yet: pick items and tiers.</span>
  {/each}
  <span class="ml-auto inline-flex items-center gap-2 whitespace-nowrap text-dark-2">
    {#if differ && shown.team}
      <Button size="sm" variant="ghost" class="h-6 px-2" onclick={() => (picked = (picked + 1) % odds.length)}>
        <span class="inline-block size-2 rounded-full" style:background-color={teamColor(shown.team)}></span>
        {shown.team} ›
      </Button>
    {/if}
    {designs} {designs === 1 ? 'design' : 'designs'} · {#if problems}<span class="text-amber-300">{problems} to fix</span>{:else}<span class="text-green-400">ready</span>{/if}
  </span>
</div>

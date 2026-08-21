<script lang="ts">
  import { tierAllowanceRows } from '$lib/monetization/paid-access';
  import { MAX_LICENSING_FEE, maxLicensingFeeCeiling } from '$lib/monetization/fee';

  // `capTier` is what the allowance resolves to, not the display tier — a lapsed membership keeps its
  // label but is allowed what free is allowed, and the highlighted row has to match what the write path
  // will actually permit.
  let { capTier = 'free', class: className = '' }: { capTier?: string; class?: string } = $props();

  const rows = tierAllowanceRows();
  const fmt = (n: number | null) => (n === null ? '∞' : n.toLocaleString());

  const rowCls = (tier: string) => (tier === capTier ? 'bg-dark-5/60 text-white' : 'text-dark-1');
  const cellCls = 'whitespace-nowrap py-1.5 pr-3 text-right tabular-nums';
</script>

<div class={className}>
  <div class="mb-3 overflow-x-auto">
    <p class="mb-1 text-xs font-medium text-white">
      New prices per month
      <span class="font-normal text-dark-2">— models you can start charging for</span>
    </p>
    <table class="w-full min-w-72 border-collapse text-left text-xs">
      <thead>
        <tr class="text-dark-2">
          <th class="py-1.5 pr-3 font-medium">Tier</th>
          <th class="py-1.5 pr-2 text-right font-medium">New prices / month</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.tier)}
          <tr class={rowCls(row.tier)}>
            <td class="whitespace-nowrap rounded-l py-1.5 pl-2 pr-3 font-medium">
              {row.label}
              {#if row.tier === capTier}<span class="ml-1 text-blue-4">· you</span>{/if}
            </td>
            <td class="{cellCls} rounded-r pr-2">{fmt(row.monthlyPrices)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <p class="text-xs text-dark-2">
    A licensing fee or a permanent paid-access price each count once, per version, the first time
    you set one. Changing or removing a price you have already set costs nothing, and a timed
    early-access window never counts.
  </p>
  <p class="mt-1 text-xs text-dark-2">
    How much you charge is the same at every tier: up to {MAX_LICENSING_FEE.toLocaleString()} ⚡ per generation
    as a licensing fee ({maxLicensingFeeCeiling('video').toLocaleString()} ⚡ for video models), and any
    price you like for paid access.
  </p>
</div>

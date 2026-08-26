<script lang="ts">
  import * as Popover from '@civitai/ui/components/ui/popover/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import {
    tierAllowanceRows,
    shouldUpsellAllowance,
    type CapTier,
  } from '$lib/monetization/paid-access';
  import { CIVITAI_MEMBERSHIP_URL } from '$lib/creator-program';

  // Turns the monthly pricing allowance from a dead end into an upgrade nudge, beside the counter the
  // creator is pressing against. Deliberately quiet: a link, not a banner, and absent until they near it.
  let {
    used,
    limit,
    capTier,
    title = 'Model versions you can price each month',
    expanded = false,
  }: {
    /** Slots spent this calendar month. */
    used: number | null | undefined;
    limit: number;
    capTier: CapTier;
    title?: string;
    /** Show the tiers inline instead of behind the trigger — for a creator already at their limit. */
    expanded?: boolean;
  } = $props();

  const show = $derived(shouldUpsellAllowance({ used, limit, tier: capTier }));
  const rows = tierAllowanceRows();
  const fmt = (n: number | null) => (n == null ? 'Unlimited' : `${n.toLocaleString()} / month`);
</script>

{#snippet capRows()}
  <p class="mb-2 text-sm font-medium text-white">{title}</p>
  <table class="w-full border-collapse text-xs">
    <tbody>
      {#each rows as row (row.tier)}
        {@const isCurrent = row.tier === capTier}
        <tr class={isCurrent ? 'font-semibold text-white' : 'text-dark-2'}>
          <td class="py-1">
            {row.label}
            {#if isCurrent}<span class="ml-1 font-normal text-blue-4">· you</span>{/if}
          </td>
          <td class="py-1 text-right tabular-nums">{fmt(row.monthlyPrices)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  <Button
    href={`${CIVITAI_MEMBERSHIP_URL}?buzzType=green`}
    target="_blank"
    variant="secondary"
    size="sm"
    class="mt-3 w-full">See membership options</Button
  >
{/snippet}

{#if expanded}
  <div class="w-full rounded-lg border border-dark-4 bg-dark-7 p-3">
    {@render capRows()}
  </div>
{:else if show}
  <Popover.Root>
    <Popover.Trigger class="text-xs text-blue-4 underline-offset-2 hover:underline">
      Want to price more model versions?
    </Popover.Trigger>
    <Popover.Content class="w-72 border-dark-4 bg-dark-7 p-3 text-sm text-white">
      {@render capRows()}
    </Popover.Content>
  </Popover.Root>
{/if}

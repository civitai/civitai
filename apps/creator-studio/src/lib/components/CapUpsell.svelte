<script lang="ts">
  import * as Popover from '@civitai/ui/components/ui/popover/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import {
    capUpsellRows,
    highlightCapTier,
    shouldUpsellCap,
    type CapTier,
  } from '$lib/monetization/paid-access';
  import { CIVITAI_MEMBERSHIP_URL } from '$lib/creator-program';

  // Turns a cap from a dead end into an upgrade nudge, beside the input the creator is pressing against.
  // Deliberately quiet: a link, not a banner, and absent until the value nears the ceiling.
  //
  // `capFor` must be the SAME expression that bounds the input — passing the function rather than a table
  // is what stops the popover quoting a number the field beside it contradicts.
  let {
    value,
    cap,
    capTier,
    capFor,
    title,
    perLabel,
  }: {
    value: number | null | undefined;
    cap: number;
    capTier: string;
    capFor: (tier: CapTier) => number;
    title: string;
    /** Denominator for a ratio-domain cap, e.g. '10 generations'. Omitted for flat prices. */
    perLabel?: string;
  } = $props();

  const show = $derived(shouldUpsellCap({ value, cap, tier: capTier }));
  const rows = $derived(capUpsellRows(capFor));
  const current = $derived(highlightCapTier(capTier));
  const fmt = (n: number) =>
    !Number.isFinite(n)
      ? 'Unlimited'
      : perLabel
        ? `${n.toLocaleString()} ⚡ / ${perLabel}`
        : `${n.toLocaleString()} ⚡`;
</script>

{#if show}
  <Popover.Root>
    <Popover.Trigger class="text-xs text-blue-4 underline-offset-2 hover:underline">
      Want to charge more?
    </Popover.Trigger>
    <Popover.Content class="w-72 border-dark-4 bg-dark-7 p-3 text-sm text-white">
      <p class="mb-2 text-sm font-medium text-white">{title}</p>
      <table class="w-full border-collapse text-xs">
        <tbody>
          {#each rows as row (row.tier)}
            {@const isCurrent = row.tier === current}
            <tr class={isCurrent ? 'font-semibold text-white' : 'text-dark-2'}>
              <td class="py-1">
                {row.label}
                {#if isCurrent}<span class="ml-1 font-normal text-blue-4">· you</span>{/if}
              </td>
              <td class="py-1 text-right tabular-nums">{fmt(row.cap)}</td>
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
    </Popover.Content>
  </Popover.Root>
{/if}

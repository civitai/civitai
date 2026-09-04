<script lang="ts">
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import CurrencyDisplay from '$lib/components/CurrencyDisplay.svelte';
  import { currencyMeta, currencySort } from '$lib/earnings';
  import {
    CHANNEL_COLOR,
    CHANNEL_DESCRIPTION,
    CHANNEL_LABEL,
    CHANNEL_SPEND,
    MONETIZATION_CHANNELS,
  } from '$lib/monetization/admin-channels';
  import type { ChannelCurrencyTotal, ChannelMoney } from '$lib/server/admin/monetization-overview';

  let { money, periodLabel }: { money: ChannelMoney[] | null; periodLabel: string } = $props();

  const num = (n: number) => n.toLocaleString();

  const rows = $derived(
    MONETIZATION_CHANNELS.map((channel) => ({
      channel,
      row: money?.find((m) => m.channel === channel) ?? null,
    }))
  );

  const sorted = (list: ChannelCurrencyTotal[]) =>
    [...list].sort((a, b) => currencySort(a.currency, b.currency));
</script>

{#snippet currencyStack(list: ChannelCurrencyTotal[])}
  {#if list.length === 0}
    <span class="text-dark-4">—</span>
  {:else}
    {#each sorted(list) as c (c.currency)}
      <div class="tabular-nums text-white" title={currencyMeta(c.currency).label}>
        <CurrencyDisplay amount={c.total} currency={c.currency} />
      </div>
    {/each}
  {/if}
{/snippet}

<section class="cs-panel p-4">
  <div class="mb-3">
    <p class="m-0 text-sm font-medium text-white">
      Money by channel <span class="text-xs font-normal text-dark-2">for {periodLabel}</span>
    </p>
    <p class="m-0 text-xs text-dark-2">
      Currencies are shown as they were transacted and are never converted or added together.
    </p>
  </div>

  {#if !money}
    <p class="placeholder">Channel totals are unavailable right now.</p>
  {:else}
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head class="w-full">Channel</Table.Head>
          <Table.Head class="w-px text-right">Spent by buyers</Table.Head>
          <Table.Head class="w-px text-right">Paid to creators</Table.Head>
          <Table.Head class="w-px text-right">Transactions</Table.Head>
          <Table.Head class="w-px text-right">Buyers</Table.Head>
          <Table.Head class="w-px text-right">Creators paid</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each rows as { channel, row } (channel)}
          {@const minted = CHANNEL_SPEND[channel] === 'minted'}
          <Table.Row class="align-top">
            <Table.Cell>
              <div class="flex items-center gap-2 text-white">
                <span
                  class="size-2 shrink-0 rounded-full"
                  style="background:{CHANNEL_COLOR[channel]}"
                ></span>
                {CHANNEL_LABEL[channel]}
              </div>
              <div class="text-xs text-dark-2">{CHANNEL_DESCRIPTION[channel]}</div>
            </Table.Cell>
            <!-- A minted channel has no payer row at all, so both the amount and the buyer count are
                 unknown rather than zero. Rendering either as 0 answers "is anyone paying?" with "no". -->
            <Table.Cell class="w-px whitespace-nowrap text-right">
              {#if minted}
                <span
                  class="text-dark-2"
                  title="Buyers pay this inside the generation charge, which no table splits out — only the payout is its own ledger row."
                  >not separable</span
                >
              {:else if CHANNEL_SPEND[channel] === 'split'}
                <!-- No inline gloss: this cell is nowrap, so any words here set the column's minimum
                     width. The explanation lives in the footnotes instead. -->
                <span
                  title="Buyers pay the platform, which then pays the creator a share — this is not the creator's income."
                >
                  {@render currencyStack(row?.spent ?? [])}
                </span>
              {:else}
                {@render currencyStack(row?.spent ?? [])}
              {/if}
            </Table.Cell>
            <Table.Cell class="w-px whitespace-nowrap text-right">
              {@render currencyStack(row?.paidOut ?? [])}
            </Table.Cell>
            <Table.Cell class="w-px whitespace-nowrap text-right tabular-nums text-dark-1">
              {num(row?.transactions ?? 0)}
            </Table.Cell>
            <Table.Cell class="w-px whitespace-nowrap text-right tabular-nums text-dark-1">
              {#if minted}
                <span class="text-dark-2" title="No payer row exists for this channel to count.">
                  not separable
                </span>
              {:else}
                {num(row?.buyers ?? 0)}
              {/if}
            </Table.Cell>
            <Table.Cell class="w-px whitespace-nowrap text-right tabular-nums text-dark-1">
              {num(row?.creators ?? 0)}
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>

    <ul class="mt-3 space-y-1 text-xs text-dark-2">
      <li>
        On access sales and donations the buyer pays the creator in one transaction, so the two
        money columns are the same money. They can still differ by currency — a green-buzz purchase
        can settle to the seller as yellow.
      </li>
      <li>
        Figures are gross. A refund is written under its own id carrying no channel, so refunded
        sales are still counted here.
      </li>
      <li>
        License-fee payouts are the settled ledger rows. Cash settles on its own schedule, so a
        recent period can show less cash here than has been earned.
      </li>
      <li>
        On the cosmetic shop the buyer pays the platform and the platform pays the creator, so the
        two columns are different money. The gap is not the 30% cut alone — official items have no
        creator to pay, and their whole price sits in the spend column.
      </li>
      <li>
        Donation goals before 13 Oct 2025 are missing: those rows predate transaction ids, and a
        goal donation from then is indistinguishable from a charity-campaign one. Access sales that
        far back are recovered by description and are complete.
      </li>
    </ul>
  {/if}
</section>

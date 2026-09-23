<script lang="ts">
  import { IconLicense, IconLock, IconTarget, IconUsers } from '@tabler/icons-svelte';
  import StatCard from '$lib/components/StatCard.svelte';
  import CurrencyDisplay from '$lib/components/CurrencyDisplay.svelte';
  import { currencySort, isBuzzCurrency } from '$lib/earnings';
  import { formatRange } from '$lib/date-range';
  import {
    CHANNEL_COLOR,
    CHANNEL_LABEL,
    MONETIZATION_CHANNELS,
  } from '$lib/monetization/admin-channels';
  import type { AdoptionRow } from '$lib/server/admin/monetization-overview';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(formatRange(data.range));

  const versions = (kind: AdoptionRow['kind']) =>
    data.adoption?.find((a) => a.kind === kind)?.versions ?? 0;

  const creatorsMonetizing = $derived(
    data.adoption?.find((a) => a.kind === 'anySetting')?.creators ?? 0
  );
  const gatedVersions = $derived(versions('permanentAccess') + versions('earlyAccessActive'));

  // The buzz families summed for a headline only — the per-channel table keeps them split, and cash is left
  // out entirely rather than being added to buzz.
  const channelBuzz = $derived(
    MONETIZATION_CHANNELS.map((channel) => {
      const row = data.money?.find((m) => m.channel === channel);
      return {
        channel,
        buzz: (row?.paidOut ?? [])
          .filter((c) => isBuzzCurrency(c.currency))
          .reduce((sum, c) => sum + c.total, 0),
      };
    }).sort((a, b) => b.buzz - a.buzz)
  );
  const cash = $derived(
    (data.money ?? [])
      .flatMap((m) => m.paidOut)
      .filter((c) => !isBuzzCurrency(c.currency))
      .reduce<{ currency: string; total: number }[]>((acc, c) => {
        const found = acc.find((x) => x.currency === c.currency);
        if (found) found.total += c.total;
        else acc.push({ currency: c.currency, total: c.total });
        return acc;
      }, [])
      .sort((a, b) => currencySort(a.currency, b.currency))
  );
</script>

<header class="page-header">
  <h1>Admin</h1>
  <p>Platform-wide creator monetization.</p>
</header>

<!-- Guarded per source, not once for the page: the two reads fail independently, and `?? 0` on a read that
     never ran would show a confident zero for a question nobody asked. -->
{#if !data.adoption}
  <p class="placeholder mb-6">Settings counts are unavailable right now.</p>
{:else}
  <div class="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <StatCard label="Creators monetizing" icon={IconUsers}>
      <p class="mt-1 text-2xl font-semibold tabular-nums text-white">{num(creatorsMonetizing)}</p>
      <p class="mt-1 text-xs text-dark-2">
        Distinct creators carrying at least one monetization setting.
      </p>
    </StatCard>
    <StatCard label="Versions gated" icon={IconLock}>
      <p class="mt-1 text-2xl font-semibold tabular-nums text-white">{num(gatedVersions)}</p>
      <p class="mt-1 text-xs text-dark-2">Permanent plus open early-access windows.</p>
    </StatCard>
    <StatCard label="Versions with a license fee" icon={IconLicense}>
      <p class="mt-1 text-2xl font-semibold tabular-nums text-white">
        {num(versions('licenseFee'))}
      </p>
      <p class="mt-1 text-xs text-dark-2">Charged per generation, independent of any gate.</p>
    </StatCard>
    <StatCard label="Open donation goals" icon={IconTarget}>
      <p class="mt-1 text-2xl font-semibold tabular-nums text-white">
        {num(versions('donationGoalActive'))}
      </p>
      <p class="mt-1 text-xs text-dark-2">Versions carrying a goal that has not completed.</p>
    </StatCard>
  </div>
{/if}

<div class="cs-panel p-4">
  <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
    <p class="m-0 text-sm font-medium text-white">
      Paid to creators <span class="text-xs font-normal text-dark-2">for {periodLabel}</span>
    </p>
    <a href="/admin/monetization" class="text-xs text-dark-2 hover:text-white">Full breakdown →</a>
  </div>

  {#if !data.money}
    <p class="placeholder">Channel totals are unavailable right now.</p>
  {:else}
    <ul class="space-y-2">
      {#each channelBuzz as { channel, buzz } (channel)}
        <li class="flex items-center gap-2 text-sm">
          <span class="size-2 shrink-0 rounded-full" style="background:{CHANNEL_COLOR[channel]}"
          ></span>
          <span class="text-dark-1">{CHANNEL_LABEL[channel]}</span>
          <span class="ml-auto tabular-nums text-white"><CurrencyDisplay amount={buzz} /></span>
        </li>
      {/each}
    </ul>
    {#if cash.length > 0}
      <div class="mt-3 border-t border-dark-4 pt-3">
        {#each cash as c (c.currency)}
          <div class="flex items-center gap-2 text-sm">
            <span class="text-dark-1">Cash settled to creators</span>
            <span class="ml-auto tabular-nums text-white">
              <CurrencyDisplay amount={c.total} currency={c.currency} />
            </span>
          </div>
        {/each}
      </div>
    {/if}
    <p class="mt-3 text-xs text-dark-2">
      Buzz families are summed for this glance only; cash is kept separate and never added to buzz.
    </p>
  {/if}
</div>

<script lang="ts">
  import { Chart } from '@civitai/ui/components/ui/chart/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import RangeSelector from '$lib/components/RangeSelector.svelte';
  import { formatRange } from '$lib/date-range';
  import {
    EARNINGS_SOURCES,
    SOURCE_LABEL,
    SOURCE_COLOR,
    currencyMeta,
    currencySort,
    formatAmount,
    formatBuzz,
    hasDisplayValue,
  } from '$lib/earnings';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Withdrawal + the live cash balance live in the main app; the studio links out to it (C6: one cash home).
  const BUZZ_DASHBOARD_URL = 'https://civitai.com/user/buzz-dashboard';

  const periodLabel = $derived(`for ${formatRange(data.range)}`);

  // ClickHouse earnings are the buzz flow by source; cash is deliberately excluded here and shown from the buzz
  // service instead (below), since CH cash figures are a period flow and can drift from the real balance.
  const currencies = $derived(
    data.summary
      ? [...new Set(data.summary.map((b) => b.currency))]
          .filter((c) => currencyMeta(c).family !== 'cash')
          .sort(currencySort)
      : []
  );
  const currencyTotals = $derived(
    currencies.map((c) => ({
      currency: c,
      total: (data.summary ?? []).filter((b) => b.currency === c).reduce((s, b) => s + b.total, 0),
    }))
  );
  // Sources present, in canonical order.
  const sources = $derived(EARNINGS_SOURCES.filter((s) => (data.summary ?? []).some((b) => b.source === s)));
  const cell = (source: string, currency: string) =>
    (data.summary ?? []).find((b) => b.source === source && b.currency === currency)?.total ?? 0;

  const hasBuzzEarnings = $derived(currencyTotals.length > 0);

  // Buzz earned per source (buzz colors summed — same unit) so licensing fees / tips / compensation are legible at
  // a glance, not just the currency split. Cash-denominated source earnings stay in the cash panel + table.
  const sourceTotals = $derived(
    sources
      .map((s) => ({
        source: s,
        total: (data.summary ?? [])
          .filter((b) => b.source === s && currencyMeta(b.currency).family === 'buzz')
          .reduce((acc, b) => acc + b.total, 0),
      }))
      .filter((x) => Math.floor(x.total) >= 1)
  );

  // Authoritative Creator Program cash — the buzz-account balance from the service (matches the Buzz dashboard),
  // NOT a ClickHouse period sum. `formatAmount` renders these cash values in USD.
  const cash = $derived(data.cash);
  const hasCash = $derived(!!cash && (cash.settled > 0 || cash.pending > 0 || cash.withdrawn > 0));

  // Trend is a buzz-only per-source line chart (cash is USD + lumpy → lives in the panel). Chips toggle sources.
  const seriesSources = $derived(EARNINGS_SOURCES.filter((s) => (data.series ?? []).some((p) => p.source === s)));
  // Visible sources (ToggleGroup value). Default every present source on; resync when the range — and thus the
  // set of sources — changes.
  let shownSources = $state<string[]>([]);
  $effect(() => {
    shownSources = [...seriesSources];
  });
  const chartData = $derived.by(() => {
    const series = data.series ?? [];
    const dates = [...new Set(series.map((p) => p.date))].sort();
    const shown = seriesSources.filter((s) => shownSources.includes(s));
    return {
      labels: dates,
      datasets: shown.map((s) => ({
        label: SOURCE_LABEL[s],
        data: dates.map((d) => series.find((p) => p.date === d && p.source === s)?.total ?? 0),
        borderColor: SOURCE_COLOR[s],
        backgroundColor: SOURCE_COLOR[s],
        tension: 0.3,
        fill: false,
        pointRadius: dates.length > 45 ? 0 : 2,
      })),
    };
  });

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: { legend: { display: false } },
    scales: { x: { ticks: { maxTicksLimit: 8, autoSkip: true } } },
  };
</script>

<header class="page-header flex flex-wrap items-start gap-3">
  <div>
    <h1>Earnings</h1>
    <p>What you earned and where it came from — shown in the currency received, without conversion.</p>
  </div>
  <div class="ml-auto">
    <RangeSelector range={data.range} />
  </div>
</header>

{#if hasCash && cash}
  <section class="mb-6 rounded-lg border border-green-9/50 bg-green-9/10 p-4">
    <div class="flex flex-wrap items-center gap-4">
      <div>
        <p class="text-xs uppercase tracking-wide text-green-4">Creator Program cash</p>
        <div class="mt-1 flex flex-wrap items-end gap-x-8 gap-y-3">
          <div>
            <p class="text-2xl font-semibold text-white">{formatAmount(cash.pending, 'cashPending')}</p>
            <p class="text-xs text-green-3">Pending settlement</p>
          </div>
          <div>
            <p class="text-2xl font-semibold text-white">{formatAmount(cash.settled, 'cashSettled')}</p>
            <p class="text-xs text-green-3">Ready to withdraw</p>
          </div>
          <div>
            <p class="text-2xl font-semibold text-white">{formatAmount(cash.withdrawn, 'cashSettled')}</p>
            <p class="text-xs text-green-3">Withdrawn</p>
          </div>
        </div>
      </div>
      <Button href={BUZZ_DASHBOARD_URL} target="_blank" rel="noreferrer" size="sm" class="ml-auto">
        Buzz Dashboard
      </Button>
    </div>
    <p class="mt-3 text-xs text-green-3">
      Your current cash balance from the Creator Program. Withdrawals happen on the Buzz dashboard.
    </p>
  </section>
{/if}

{#if !data.summary}
  <div class="placeholder">Earnings are temporarily unavailable — please try again shortly.</div>
{:else if !hasBuzzEarnings}
  <div class="placeholder flex flex-col items-center justify-center h-full">
    {#if data.membership.isCreatorProgramMember}
      <span>No buzz earnings {periodLabel}. Set licensing fees or access prices on
      <a href="/models" class="underline">your models</a> to start earning.</span>
    {:else}
      <span>You're not in the Creator Program yet, so there's nothing to show here.</span>
      <span><a href="/join" class="underline">Join to start earning</a> from your models.</span>
    {/if}
  </div>
{:else}
  <p class="mb-2 text-xs text-dark-3">Earned by source · buzz {periodLabel}</p>
  <section class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
    {#each sourceTotals as st (st.source)}
      <div class="rounded-lg border border-dark-4 bg-dark-6 p-3">
        <p class="text-xs uppercase tracking-wide text-dark-3">{SOURCE_LABEL[st.source]}</p>
        <p class="mt-1 text-xl font-semibold text-white">{formatBuzz(st.total)}</p>
      </div>
    {/each}
  </section>

  <div class="mb-6 rounded-lg border border-dark-4 bg-dark-6 p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm text-dark-2">
        Buzz earned by source over time <span class="text-xs text-dark-3">· cash shown in the panel above</span>
      </p>
      <ToggleGroup type="multiple" bind:value={shownSources} variant="outline" size="sm" spacing={1.5} class="flex-wrap">
        {#each seriesSources as s (s)}
          <ToggleGroupItem value={s} aria-label={SOURCE_LABEL[s]} class="gap-1.5 text-xs">
            <span
              class="inline-block h-2 w-2 rounded-full"
              style="background:{shownSources.includes(s)
                ? SOURCE_COLOR[s]
                : 'transparent'};border:1px solid {SOURCE_COLOR[s]}"
            ></span>
            {SOURCE_LABEL[s]}
          </ToggleGroupItem>
        {/each}
      </ToggleGroup>
    </div>
    <div class="h-72">
      <Chart type="line" data={chartData} options={chartOptions} class="h-full" />
    </div>
  </div>

  <div class="rounded-lg border border-dark-4 bg-dark-6 p-4">
    <p class="mb-3 text-sm text-dark-2">By source <span class="text-xs text-dark-3">{periodLabel}</span></p>
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Source</Table.Head>
          {#each currencies as c (c)}
            <Table.Head class="text-right">{currencyMeta(c).label}</Table.Head>
          {/each}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each sources as s (s)}
          <Table.Row>
            <Table.Cell class="text-dark-1">{SOURCE_LABEL[s]}</Table.Cell>
            {#each currencies as c (c)}
              {@const v = cell(s, c)}
              {@const show = hasDisplayValue(v, c)}
              <Table.Cell class="text-right {show ? 'font-medium text-white' : 'text-dark-4'}">
                {show ? formatAmount(v, c) : '—'}
              </Table.Cell>
            {/each}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
{/if}

<div class="mt-8 rounded-lg border border-dashed border-dark-4 p-4 text-sm text-dark-3">
  <strong class="text-dark-2">These totals are creator-level.</strong> For earnings broken down by individual
  model, see <a href="/analytics" class="underline">Analytics</a>.
</div>

<script lang="ts">
  import { Chart } from '@civitai/ui/components/ui/chart/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import { IconFilter } from '@tabler/icons-svelte';
  import RangeSelector from '$lib/components/RangeSelector.svelte';
  import StatCard from '$lib/components/StatCard.svelte';
  import DeltaChip from '$lib/components/DeltaChip.svelte';
  import ChartTypeToggle from '$lib/components/ChartTypeToggle.svelte';
  import { chartType } from '$lib/stores/chart-type';
  import { earningsCombined } from '$lib/stores/earnings-combined';
  import { formatRange, dayDiff, shiftIso, eachDayIso } from '$lib/date-range';
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

  // Monthly performance table (feedback 3.4) — last 12 months, most recent first, currencies split (B8). Each cell
  // carries a % delta vs the same currency the month before, so "is this month doing well?" is answerable at a
  // glance. Independent of the selected range above.
  const monthlyMonths = $derived(
    data.monthly ? [...new Set(data.monthly.map((m) => m.month))].sort().reverse() : []
  );
  const monthlyCurrencies = $derived(
    data.monthly ? [...new Set(data.monthly.map((m) => m.currency))].sort(currencySort) : []
  );
  const monthlyCell = (month: string, currency: string) =>
    data.monthly?.find((m) => m.month === month && m.currency === currency)?.total ?? 0;
  const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const formatMonth = (m: string) => monthFmt.format(Date.parse(`${m}T00:00:00Z`));

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

  // One source filter governs the whole earnings section (868ke494r): the by-source cards, the by-source table, and
  // the trend all read `shownSources`. Default every present source on; reset when the range — and thus the set of
  // present sources — changes. When any source is hidden, every affected section is flagged (isFiltered) so the
  // reduced totals aren't misread as the full picture.
  let shownSources = $state<string[]>([]);
  $effect(() => {
    shownSources = [...sources];
  });
  const visibleSources = $derived(sources.filter((s) => shownSources.includes(s)));
  const isFiltered = $derived(sources.length > 0 && visibleSources.length < sources.length);
  const hiddenCount = $derived(sources.length - visibleSources.length);

  // Buzz earned per source (buzz colors summed — same unit) so licensing fees / tips / compensation are legible at
  // a glance, not just the currency split. Cash-denominated source earnings stay in the cash panel + table.
  const sourceTotals = $derived(
    visibleSources
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

  // Trend is a buzz-only per-source line chart (cash is USD + lumpy → lives in the panel).
  const seriesSources = $derived(EARNINGS_SOURCES.filter((s) => (data.series ?? []).some((p) => p.source === s)));
  // The trend collapses the *selected* sources into one total-per-day line. The comparison line sums the SAME
  // selection from the chosen baseline period and lines it up under the current days by ordinal offset (`delta`), so
  // any earlier period — the immediately-prior one or an arbitrary month — reads like-for-like.
  const chartData = $derived.by(() => {
    // Full selected month on the x-axis, so a partial current month still renders the whole month. The current line
    // draws real 0s for elapsed days with no earnings, then `null` (a gap — line stops) for days after `through`.
    const dates = eachDayIso(data.range);
    const shown = new Set<string>(seriesSources.filter((s) => shownSources.includes(s)));
    const sumSelected = (rows: { date: string; source: string; total: number }[]) => {
      const byDate = new Map<string, number>();
      for (const p of rows) if (shown.has(p.source)) byDate.set(p.date, (byDate.get(p.date) ?? 0) + p.total);
      return byDate;
    };
    const currentByDate = sumSelected(data.series ?? []);
    const cmpByDate = sumSelected(data.cmpSeries ?? []);
    const delta = dayDiff(data.range.from, data.compare.from);
    return {
      labels: dates,
      datasets: [
        {
          label: 'This period',
          data: dates.map((d) => (d <= data.through ? (currentByDate.get(d) ?? 0) : null)),
          borderColor: '#4dabf7',
          backgroundColor: '#4dabf7',
          tension: 0.3,
          fill: false,
          pointRadius: dates.length > 45 ? 0 : 2,
          // Higher order = drawn first (underneath), so the current-period bars sit below the comparison line.
          order: 1,
        },
        ...(data.cmpSeries != null
          ? [
              {
                // The comparison month draws a real 0 for its own no-earnings days, but `null` (a gap) for axis slots
                // past its last day — e.g. a 30-day June under a 31-day July shouldn't drop to 0 on the 31st. Always a
                // line — even in bar mode — so the overlay reads clearly (868ke4939).
                type: 'line' as const,
                label: data.compare.label,
                data: dates.map((d) => {
                  const cd = shiftIso(d, delta);
                  return cd <= data.compare.to ? (cmpByDate.get(cd) ?? 0) : null;
                }),
                borderColor: '#868e96',
                backgroundColor: '#868e96',
                borderDash: [4, 4],
                tension: 0.3,
                fill: false,
                pointRadius: 0,
                // Lower order = drawn on top, so the comparison line stays visible over the bars.
                order: 0,
              },
            ]
          : []),
      ],
    };
  });

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: { legend: { display: false } },
    scales: { x: { ticks: { maxTicksLimit: 8, autoSkip: true } } },
  };

  // Split per-currency (B8) ↔ one combined Total Buzz column (868ke492g) — the "total value of Buzz" view. The
  // individual split stays the default; the choice persists to localStorage.
  const combined = $derived(earningsCombined.value);
  // Total buzz for a source across every buzz currency present (yellow + green + …) — the combined column's cell.
  const buzzTotal = (source: string) => currencies.reduce((sum, c) => sum + cell(source, c), 0);

  // Buzz→$ conversion history (868ke492x). `perThousand` is already the capped $-per-1k rate from the server.
  const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const rateFmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });

  // Per-source comparison totals (vs the chosen comparison month) for the delta chips on the cards + table.
  const cmpSourceBuzz = (source: string) =>
    (data.cmpSummary ?? [])
      .filter((b) => b.source === source && currencyMeta(b.currency).family === 'buzz')
      .reduce((s, b) => s + b.total, 0);
  const cmpCell = (source: string, currency: string) =>
    (data.cmpSummary ?? []).find((b) => b.source === source && b.currency === currency)?.total ?? 0;
  const cmpBuzzTotal = (source: string) => currencies.reduce((sum, c) => sum + cmpCell(source, c), 0);
</script>

<header class="page-header flex flex-wrap items-start gap-3">
  <div>
    <h1>Earnings</h1>
    <p>What you earned and where it came from — shown in the currency received, without conversion.</p>
  </div>
  <div class="ml-auto">
    <RangeSelector range={data.range} compare={data.compare} />
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
  {#if sources.length > 1}
    <section class="mb-4 cs-panel p-3">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-xs font-medium uppercase tracking-wide text-dark-2">Sources</span>
        <ToggleGroup
          type="multiple"
          value={shownSources}
          onValueChange={(v) => {
            if (v.length) shownSources = v;
          }}
          variant="outline"
          size="sm"
          spacing={1.5}
          class="flex-wrap"
        >
          {#each sources as s (s)}
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
        {#if isFiltered}
          <div class="ml-auto flex items-center gap-2">
            <span
              class="inline-flex items-center gap-1 rounded border border-yellow-5/40 bg-yellow-5/10 px-2 py-1 text-xs font-medium text-yellow-5"
            >
              <IconFilter size={12} />
              Filtered · hiding {hiddenCount} of {sources.length} sources
            </span>
            <button
              type="button"
              onclick={() => (shownSources = [...sources])}
              class="cursor-pointer text-xs text-blue-4 hover:underline"
            >
              Show all
            </button>
          </div>
        {/if}
      </div>
      {#if isFiltered}
        <p class="mt-2 text-xs text-yellow-5/80">
          The totals and charts below exclude the hidden sources — they aren't your full earnings.
        </p>
      {/if}
    </section>
  {/if}

  <p class="mb-2 text-xs text-dark-2">
    Earned by source · buzz {periodLabel}{#if isFiltered}<span class="font-medium text-yellow-5"> · filtered</span
      >{/if}
  </p>
  <section class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
    {#each sourceTotals as st (st.source)}
      <StatCard label={SOURCE_LABEL[st.source]}>
        <p class="mt-1 text-xl font-semibold text-white">{formatBuzz(st.total)}</p>
        <div class="mt-1">
          <DeltaChip current={st.total} previous={cmpSourceBuzz(st.source)} label="vs {data.compare.label}" />
        </div>
      </StatCard>
    {/each}
  </section>

  <div class="mb-6 cs-panel p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm font-medium text-white">
        Buzz earned over time
        <span class="text-xs text-dark-3">· this month vs {data.compare.label}</span>{#if isFiltered}<span
            class="text-xs font-medium text-yellow-5"
          >
            · filtered</span
          >{/if}
      </p>
      <ChartTypeToggle />
    </div>
    <div class="h-72">
      {#key chartType.value}
        <Chart type={chartType.value} data={chartData} options={chartOptions} class="h-full" />
      {/key}
    </div>
  </div>

  <div class="cs-panel p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm font-medium text-white">
        By source <span class="text-xs text-dark-3">{periodLabel}</span>{#if isFiltered}<span
            class="text-xs font-medium text-yellow-5"
          >
            · filtered</span
          >{/if}
      </p>
      <ToggleGroup
        type="single"
        value={combined ? 'combined' : 'split'}
        onValueChange={(v: string) => {
          if (v) earningsCombined.set(v === 'combined');
        }}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="split" aria-label="Split by currency" class="text-xs">Split</ToggleGroupItem>
        <ToggleGroupItem value="combined" aria-label="Combined Buzz total" class="text-xs">Combined</ToggleGroupItem>
      </ToggleGroup>
    </div>
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Source</Table.Head>
          {#if combined}
            <Table.Head class="text-right">Total Buzz</Table.Head>
          {:else}
            {#each currencies as c (c)}
              <Table.Head class="text-right">{currencyMeta(c).label}</Table.Head>
            {/each}
          {/if}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each visibleSources as s (s)}
          <Table.Row>
            <Table.Cell class="text-dark-1">{SOURCE_LABEL[s]}</Table.Cell>
            {#if combined}
              {@const total = buzzTotal(s)}
              {@const show = Math.floor(total) >= 1}
              <Table.Cell class="text-right align-top {show ? 'font-medium text-white' : 'text-dark-4'}">
                <div>{show ? formatBuzz(total) : '—'}</div>
                {#if show}
                  <div class="mt-0.5"><DeltaChip current={total} previous={cmpBuzzTotal(s)} /></div>
                {/if}
              </Table.Cell>
            {:else}
              {#each currencies as c (c)}
                {@const v = cell(s, c)}
                {@const show = hasDisplayValue(v, c)}
                <Table.Cell class="text-right align-top {show ? 'font-medium text-white' : 'text-dark-4'}">
                  <div>{show ? formatAmount(v, c) : '—'}</div>
                  {#if show}
                    <div class="mt-0.5"><DeltaChip current={v} previous={cmpCell(s, c)} /></div>
                  {/if}
                </Table.Cell>
              {/each}
            {/if}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
{/if}

{#if monthlyMonths.length}
  <div class="mt-6 cs-panel p-4">
    <p class="mb-3 text-sm font-medium text-white">
      Monthly performance <span class="text-xs text-dark-3">· buzz, last 12 months</span>
    </p>
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Month</Table.Head>
          {#each monthlyCurrencies as c (c)}
            <Table.Head class="text-right">{currencyMeta(c).label}</Table.Head>
          {/each}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each monthlyMonths as month, i (month)}
          {@const prevMonth = monthlyMonths[i + 1]}
          <Table.Row class={i === 0 ? 'bg-dark-5/30' : ''}>
            <Table.Cell class="align-top text-dark-1">{formatMonth(month)}</Table.Cell>
            {#each monthlyCurrencies as c (c)}
              {@const v = monthlyCell(month, c)}
              {@const show = hasDisplayValue(v, c)}
              <Table.Cell class="align-top text-right">
                <div class="tabular-nums {show ? 'font-medium text-white' : 'text-dark-4'}">
                  {show ? formatAmount(v, c) : '—'}
                </div>
                {#if prevMonth && show}
                  <div class="mt-0.5">
                    <DeltaChip current={v} previous={monthlyCell(prevMonth, c)} label="vs previous month" />
                  </div>
                {/if}
              </Table.Cell>
            {/each}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
{/if}

{#if data.buzzRatio?.length}
  <div class="mt-6 cs-panel p-4">
    <p class="mb-1 text-sm font-medium text-white">
      Buzz → $ conversion <span class="text-xs text-dark-3">· what your banked Buzz was worth each month</span>
    </p>
    <p class="mb-3 text-xs text-dark-3">
      Your Creator Program cash payout ÷ the Buzz you banked that month. Capped at $1.00 per 1,000 Buzz. The current
      month appears once its pool settles.
    </p>
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Month</Table.Head>
          <Table.Head class="text-right">Banked Buzz</Table.Head>
          <Table.Head class="text-right">Cash earned</Table.Head>
          <Table.Head class="text-right">Per 1,000 Buzz</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each data.buzzRatio as r (r.month)}
          <Table.Row>
            <Table.Cell class="text-dark-1">{formatMonth(r.month)}</Table.Cell>
            <Table.Cell class="text-right tabular-nums text-white">{formatBuzz(r.bankedBuzz)}</Table.Cell>
            <Table.Cell class="text-right tabular-nums text-white">{usdFmt.format(r.usd)}</Table.Cell>
            <Table.Cell class="text-right font-medium tabular-nums text-green-4">
              {rateFmt.format(r.perThousand)}
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
{/if}

<div class="mt-8 rounded-lg border border-dashed border-dark-4 p-4 text-sm text-dark-3">
  <strong class="text-dark-2">These totals are creator-level.</strong> For earnings broken down by individual
  model, see <a href="/analytics/models" class="underline">Model analytics</a>.
</div>

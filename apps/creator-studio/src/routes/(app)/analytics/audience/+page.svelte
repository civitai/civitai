<script lang="ts">
  import { Chart, chartColor } from '@civitai/ui/components/ui/chart/index.js';
  import StatCard from '$lib/components/StatCard.svelte';
  import DeltaChip from '$lib/components/DeltaChip.svelte';
  import ChartTypeToggle from '$lib/components/ChartTypeToggle.svelte';
  import { chartType } from '$lib/stores/chart-type';
  import { IconUserPlus, IconHeart, IconMessage } from '@tabler/icons-svelte';
  import { formatRange, dayDiff, shiftIso } from '$lib/date-range';
  import type { TimePoint } from '$lib/server/analytics';
  import AnalyticsHeader from '$lib/components/AnalyticsHeader.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);
  const mmdd = (d: string) => (d.length >= 10 ? d.slice(5, 10) : d);

  // Percentages are of the positive buckets only. A bucket can net negative over the range (un-reacting something
  // reacted before it), which would otherwise produce a negative-width bar.
  const splitTotal = $derived(
    data.reactionSplit
      ? [
          data.reactionSplit.followers,
          data.reactionSplit.nonFollowers,
          data.reactionSplit.self,
        ].reduce((acc, b) => acc + Math.max(0, b.reactions), 0)
      : 0
  );
  const pct = (n: number) => (splitTotal > 0 ? (Math.max(0, n) / splitTotal) * 100 : 0);
  const splitRows = $derived(
    data.reactionSplit
      ? [
          { label: 'Followers', bucket: data.reactionSplit.followers, color: chartColor(1) },
          { label: 'Not following', bucket: data.reactionSplit.nonFollowers, color: chartColor(0) },
          ...(data.reactionSplit.self.reactions > 0
            ? [{ label: 'You', bucket: data.reactionSplit.self, color: '#868e96' }]
            : []),
        ]
      : []
  );

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    interaction: { mode: 'index' as const, intersect: false },
    elements: { point: { hoverRadius: 5, hitRadius: 16 } },
    scales: {
      x: { ticks: { maxTicksLimit: 8, autoSkip: true, maxRotation: 0, align: 'inner' as const } },
    },
  };

  function lineData(
    series: TimePoint[],
    label: string,
    colorIndex: number,
    prevSeries: TimePoint[] = []
  ) {
    const delta = dayDiff(data.range.from, data.compare.from);
    const prevByDate = new Map(prevSeries.map((p) => [p.date, p.value]));
    return {
      labels: series.map((p) => mmdd(p.date)),
      datasets: [
        {
          label,
          // Gap-filled to month end; stop the line at today so a partial current month doesn't dip to zero.
          data: series.map((p) => (p.date <= data.through ? p.value : null)),
          borderColor: chartColor(colorIndex),
          backgroundColor: chartColor(colorIndex),
          tension: 0.3,
          fill: false,
          pointRadius: series.length > 45 ? 0 : 2,
        },
        ...(prevSeries.length
          ? [
              {
                type: 'line' as const,
                label: data.compare.label,
                // Stop the comparison line where its (possibly shorter) month ends.
                data: series.map((p) => {
                  const cd = shiftIso(p.date, delta);
                  return cd <= data.compare.to ? (prevByDate.get(cd) ?? 0) : null;
                }),
                borderColor: '#868e96',
                backgroundColor: '#868e96',
                borderDash: [4, 4],
                tension: 0.3,
                fill: false,
                pointRadius: 0,
              },
            ]
          : []),
      ],
    };
  }
</script>

<AnalyticsHeader range={data.range} compare={data.compare} />

{#if !data.analytics}
  <div class="placeholder">
    Audience analytics are temporarily unavailable — please try again shortly.
  </div>
{:else}
  <section class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
    <StatCard label="New followers" icon={IconUserPlus} color="#4dabf7">
      <div class="mt-1 flex items-baseline gap-2">
        <p class="text-xl font-semibold text-white">{num(data.analytics.totals.followers)}</p>
        <DeltaChip
          current={data.analytics.totals.followers}
          previous={data.analyticsPrev?.totals.followers ?? null}
        />
      </div>
    </StatCard>
    {#if data.allTime}
      <!-- These two have different scopes and the labels have to carry it: reactions are all-content, comments are
           images only. Comments on models, posts and articles still aren't counted. -->
      <StatCard label="All-time reactions (all content)" icon={IconHeart} color="#ff6b6b">
        <p class="mt-1 text-xl font-semibold text-white">{num(data.allTime.reactions)}</p>
      </StatCard>
      <StatCard label="All-time image comments (incl. replies)" icon={IconMessage} color="#20c997">
        <p class="mt-1 text-xl font-semibold text-white">{num(data.allTime.comments)}</p>
      </StatCard>
    {/if}
  </section>

  <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
    <div class="cs-panel p-4">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm font-medium text-white">
          New followers over time <span class="text-xs text-dark-3">{periodLabel}</span>
        </p>
        <ChartTypeToggle />
      </div>
      <div class="h-64">
        {#key chartType.value}
          <Chart
            type={chartType.value}
            data={lineData(
              data.analytics.followers,
              'New followers',
              1,
              data.analyticsPrev?.followers
            )}
            options={commonOptions}
            class="h-full"
          />
        {/key}
      </div>
    </div>
    <div class="cs-panel p-4">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm font-medium text-white">
          Reactions received over time <span class="text-xs text-dark-3">{periodLabel}</span>
        </p>
        <ChartTypeToggle />
      </div>
      <div class="h-64">
        {#key chartType.value}
          <Chart
            type={chartType.value}
            data={lineData(data.analytics.reactions, 'Reactions', 0, data.analyticsPrev?.reactions)}
            options={commonOptions}
            class="h-full"
          />
        {/key}
      </div>
    </div>
  </div>

  {#if data.reactionSplit && splitTotal > 0}
    <div class="cs-panel mt-4 p-4">
      <p class="mb-3 text-sm font-medium text-white">
        Who reacted <span class="text-xs text-dark-3">{periodLabel}</span>
      </p>
      <div class="mb-3 flex h-2 overflow-hidden rounded-full bg-dark-5">
        <div
          class="h-full"
          style="width: {pct(data.reactionSplit.followers.reactions)}%; background: {chartColor(1)}"
        ></div>
        <div
          class="h-full"
          style="width: {pct(data.reactionSplit.nonFollowers.reactions)}%; background: {chartColor(
            0
          )}"
        ></div>
      </div>
      <dl class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {#each splitRows as row (row.label)}
          <div class="flex items-baseline justify-between gap-3">
            <dt class="flex items-center gap-2 text-sm text-dark-1">
              <span class="size-2 rounded-full" style="background: {row.color}"></span>
              {row.label}
            </dt>
            <dd class="text-sm text-white">
              <span class="font-semibold">{num(row.bucket.reactions)}</span>
              <span class="text-xs text-dark-3">
                ({pct(row.bucket.reactions).toFixed(1)}% · {num(row.bucket.reactors)}
                {row.bucket.reactors === 1 ? 'person' : 'people'})
              </span>
            </dd>
          </div>
        {/each}
      </dl>
      <p class="mt-3 text-xs text-dark-3">
        Following is counted as of now, not as of the reaction — we don't keep a history of follows.
      </p>
    </div>
  {/if}

  <!-- No comments-over-time chart: comment events carry no owner, so scoping them to a creator needs a
       per-entity-type join. Deferred until ownerId is denormalized onto comments (round-5 checklist). -->
{/if}

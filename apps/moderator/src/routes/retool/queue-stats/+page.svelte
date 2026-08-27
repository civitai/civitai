<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Chart, chartColor } from '@civitai/ui/components/ui/chart/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { ActionData, PageData } from './$types';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const stats = $derived(data.stats);

  const peak = (points: { count: number }[]) => Math.max(...points.map((p) => p.count), 0);

  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // `@civitai/ui`'s themed Chart.js wrapper, as five creator-studio pages use. Category labels, not a
  // time axis — the wrapper registers no date adapter, so the hour is pre-formatted here.
  const hourLabel = (iso: string | Date) =>
    new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });

  const chartData = (points: { hour: string | Date; count: number }[], label: string) => ({
    labels: points.map((p) => hourLabel(p.hour)),
    datasets: [
      {
        label,
        data: points.map((p) => p.count),
        borderColor: chartColor(0),
        backgroundColor: chartColor(0),
        fill: false,
        pointRadius: 0,
      },
    ],
  });

  // The x labels are dense at 200 points; Chart.js thins them itself, and the tooltip carries the value.
  const chartOptions = { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } };

  const charts = $derived([
    { label: 'Images', points: stats.images },
    { label: 'Models', points: stats.models },
  ]);
</script>

<header class="page-header">
  <h1>Queue stats</h1>
  <p>
    Upload rate and who has been working the rating queues. Retool loaded these on demand — they are
    unindexed aggregates, so this page is deliberately separate from the dashboard.
  </p>
  <!-- Said once here rather than per tick: the hour labels are chart axis categories, where repeating a
       zone on every one is noise. Everywhere else `dateTime` carries it. -->
  <p class="text-sm text-dark-2">Times below are in your local timezone ({localZone}).</p>
</header>

{#if form?.error}
  <ErrorAlert class="mb-4" message={form.error} />
{:else if form?.success}
  <div
    class="mb-4 rounded-md border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200"
    role="status"
  >
    Queue split at {dateTime(form.at)}.
  </div>
{/if}

<div class="mb-4 grid gap-3 lg:grid-cols-2">
  {#each charts as chart (chart.label)}
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-sm font-semibold text-white">{chart.label} uploaded per hour</h2>
        <span class="text-xs text-dark-2">
          last {stats.hours}h · peak {num(peak(chart.points))}
        </span>
      </div>
      {#if chart.points.length < 2}
        <p class="text-sm text-dark-2">Not enough data to plot.</p>
      {:else}
        <div class="h-40">
          <Chart
            type="line"
            data={chartData(chart.points, `${chart.label} per hour`)}
            options={chartOptions}
          />
        </div>
      {/if}
    </section>
  {/each}
</div>

<div class="mb-4 grid gap-3 lg:grid-cols-2">
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-1 text-sm font-semibold text-white">Ratings set</h2>
    <p class="mb-3 text-xs text-dark-2">
      `setNsfwLevel` actions in the last {stats.raterDays} days. Retool counted all time; this is
      bounded because the question is current throughput, not lifetime totals.
    </p>
    {#if stats.raters.length === 0}
      <p class="text-sm text-dark-2">Nobody has set a rating in this window.</p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each stats.raters as r (r.userId ?? r.username)}
          <li class="flex items-baseline justify-between gap-3">
            {#if r.userId}
              <a href={userLookupUrl(r.userId)} class={LINK_CLASS}>{r.username ?? `#${r.userId}`}</a>
            {:else}
              <span class="text-dark-0">{r.username ?? 'unknown'}</span>
            {/if}
            <span class="tabular-nums text-dark-2">{num(r.count)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-1 text-sm font-semibold text-white">Research ratings</h2>
    <p class="mb-3 text-xs text-dark-2">All time, from the research rating set.</p>
    {#if stats.researchRaters.length === 0}
      <p class="text-sm text-dark-2">No research ratings recorded.</p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each stats.researchRaters as r (r.userId ?? r.username)}
          <li class="flex items-baseline justify-between gap-3">
            {#if r.userId}
              <a href={userLookupUrl(r.userId)} class={LINK_CLASS}>{r.username ?? `#${r.userId}`}</a>
            {:else}
              <span class="text-dark-0">unknown</span>
            {/if}
            <span class="tabular-nums text-dark-2">{num(r.count)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-sm font-semibold text-white">Split the front-page queue</h2>
  <!-- Retool's button69 tooltip, which is an operating rule and appears in no query. Splitting a queue
       that is keeping up just creates a second stream with nothing in it. -->
  <p class="mb-3 text-xs text-dark-2">
    Forks the front-page rating sweep into a current stream and a catch-up stream.
    <strong class="text-amber-300">Only do this if it is 4 or more hours behind.</strong>
    {#if data.splitAt}
      Last split {dateTime(data.splitAt)}.
    {:else}
      Never split.
    {/if}
  </p>
  <form method="POST" action="?/split" use:enhance>
    <Button type="submit" variant="outline" size="sm">Split queue</Button>
  </form>
</section>

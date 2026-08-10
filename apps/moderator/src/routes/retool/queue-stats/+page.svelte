<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const stats = $derived(data.stats);

  // Inline SVG rather than a charting dependency: two series of ~200 points with no interaction is
  // not worth a library, and the app has none today.
  const path = (points: { count: number }[], width = 600, height = 80) => {
    if (points.length < 2) return '';
    const max = Math.max(...points.map((p) => p.count), 1);
    const step = width / (points.length - 1);
    return points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - (p.count / max) * height).toFixed(1)}`)
      .join(' ');
  };

  const peak = (points: { count: number }[]) => Math.max(...points.map((p) => p.count), 0);

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
</header>

{#if form?.error}
  <div
    class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    role="alert"
  >
    {form.error}
  </div>
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
        <svg
          viewBox="0 0 600 80"
          class="h-20 w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label="{chart.label} uploaded per hour over the last {stats.hours} hours"
        >
          <path
            d={path(chart.points)}
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            class="text-blue-4"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <div class="flex justify-between text-xs text-dark-2">
          <span>{dateTime(chart.points[0].hour)}</span>
          <span>{dateTime(chart.points[chart.points.length - 1].hour)}</span>
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
        {#each stats.researchRaters as r (r.username)}
          <li class="flex items-baseline justify-between gap-3">
            <span class="text-dark-0">{r.username ?? 'unknown'}</span>
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

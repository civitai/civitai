<script lang="ts">
  import { Chart, chartColor } from '@civitai/ui/components/ui/chart/index.js';
  import { ANNOUNCEMENT_METRICS_SINCE_LABEL } from '$lib/impressions';
  import type { MutePoint } from '$lib/server/announcement-analytics';

  let { mutedNow, series }: { mutedNow: number; series: MutePoint[] } = $props();

  const num = (n: number) => n.toLocaleString();
  const mmdd = (d: string) => (d.length >= 10 ? d.slice(5, 10) : d);

  // Muting is per creator, not per announcement — a reader muting you stops seeing all of them —
  // so this is one panel about the whole feed rather than a column on a row.
  const chart = $derived({
    labels: series.map((p) => mmdd(p.date)),
    datasets: [
      {
        label: 'Muted',
        data: series.map((p) => p.muted),
        borderColor: chartColor(0),
        backgroundColor: chartColor(0),
      },
      {
        label: 'Unmuted',
        data: series.map((p) => p.unmuted),
        borderColor: chartColor(1),
        backgroundColor: chartColor(1),
      },
    ],
  });

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: true } },
    interaction: { mode: 'index' as const, intersect: false },
    scales: {
      x: { ticks: { maxTicksLimit: 8, autoSkip: true, maxRotation: 0, align: 'inner' as const } },
      y: { beginAtZero: true, ticks: { precision: 0 } },
    },
  };
</script>

<div class="cs-panel p-4">
  <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
    <p class="text-sm font-medium text-white">
      {num(mutedNow)}
      {mutedNow === 1 ? 'person has' : 'people have'} muted your announcements
    </p>
    <p class="text-xs text-dark-2">They still see your profile, just not these.</p>
  </div>

  {#if series.length > 0}
    <div class="h-48">
      <!-- Bars, not a line: mutes are daily counts, and a line through a single day renders as an
           invisible point — which is the state every creator is in for the first day. -->
      <Chart type="bar" data={chart} {options} class="h-full" />
    </div>
  {:else}
    <!-- An empty series and a quiet week look identical on a chart, and this one is empty for
         everyone until the first mute lands after the ship date. Say which it is. -->
    <p class="text-xs text-dark-2">
      Nothing to chart yet — mutes and unmutes have been recorded since {ANNOUNCEMENT_METRICS_SINCE_LABEL},
      and none have happened since.
    </p>
  {/if}
</div>

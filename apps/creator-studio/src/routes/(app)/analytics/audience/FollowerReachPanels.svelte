<script lang="ts">
  import { Chart, chartColor } from '@civitai/ui/components/ui/chart/index.js';
  import StatCard from '$lib/components/StatCard.svelte';
  import { IconUsers, IconWorld } from '@tabler/icons-svelte';
  import {
    REACH_WINDOWS,
    countryName,
    MIN_FOLLOWERS_FOR_REACH,
    MIN_FOLLOWERS_PER_COUNTRY,
    MAX_COUNTRY_SLICES,
    type FollowerReach,
  } from '$lib/analytics/follower-reach';

  let { reach }: { reach: FollowerReach } = $props();

  const num = (n: number) => n.toLocaleString();
  const share = (n: number) => (reach.followers > 0 ? (n / reach.followers) * 100 : 0);

  const breakdown = $derived(reach.countries);

  // `key` is the country code, not the label: `Intl.DisplayNames` degrades to the raw code on runtimes
  // missing locale data, and two rows keyed alike would swap a swatch onto the wrong count.
  const slices = $derived([
    ...breakdown.slices.map((s, i) => ({
      key: s.code,
      label: countryName(s.code),
      followers: s.followers,
      color: chartColor(i),
    })),
    ...(breakdown.other > 0
      ? [{ key: '__other', label: 'Other countries', followers: breakdown.other, color: '#868e96' }]
      : []),
    ...(breakdown.unknown > 0
      ? [{ key: '__unknown', label: 'Unknown', followers: breakdown.unknown, color: '#4a4a4a' }]
      : []),
  ]);

  const doughnutData = $derived({
    labels: slices.map((s) => s.label),
    datasets: [
      {
        data: slices.map((s) => s.followers),
        backgroundColor: slices.map((s) => s.color),
        borderWidth: 0,
      },
    ],
  });

  const doughnutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '58%',
    plugins: { legend: { display: false } },
  };
</script>

<section class="mt-4">
  <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
    <p class="text-sm font-medium text-white">
      Active reach <span class="text-xs text-dark-2">of your {num(reach.followers)} followers</span>
    </p>
  </div>

  <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
    {#each REACH_WINDOWS as days (days)}
      <StatCard label="Active in the last {days} days" icon={IconUsers} color="#4dabf7">
        <div class="mt-1 flex items-baseline gap-2">
          <p class="text-xl font-semibold text-white">{share(reach.active[days]).toFixed(1)}%</p>
          <p class="text-xs text-dark-2">{num(reach.active[days])} people</p>
        </div>
      </StatCard>
    {/each}
  </div>

  <p class="mt-2 text-xs text-dark-2">
    A follower counts as active if we saw any tracked activity from them — a page view, a reaction,
    or a sign-in. The windows nest, so everyone in the 30-day figure is also in the 60- and 100-day
    ones.
  </p>
</section>

{#if slices.length > 0}
  <div class="cs-panel mt-4 p-4">
    <div class="mb-3 flex items-center gap-1.5">
      <IconWorld size={15} color="#20c997" />
      <p class="text-sm font-medium text-white">Where your followers are</p>
    </div>
    <div class="grid grid-cols-1 items-center gap-4 sm:grid-cols-[14rem_1fr]">
      <div class="h-56" aria-hidden="true">
        <Chart type="doughnut" data={doughnutData} options={doughnutOptions} class="h-full" />
      </div>
      <dl class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {#each slices as slice (slice.key)}
          <div class="flex items-baseline justify-between gap-3">
            <dt class="flex items-center gap-2 text-sm text-dark-1">
              <span class="size-2 shrink-0 rounded-full" style="background: {slice.color}"></span>
              {slice.label}
            </dt>
            <dd class="whitespace-nowrap text-sm text-white">
              <span class="font-semibold">{num(slice.followers)}</span>
              <span class="text-xs text-dark-2">({share(slice.followers).toFixed(1)}%)</span>
            </dd>
          </div>
        {/each}
      </dl>
    </div>
    <p class="mt-3 text-xs text-dark-2">
      Country comes from where a follower was last browsing, so a VPN reads as wherever it exits.
      Your top {MAX_COUNTRY_SLICES} countries are listed; the rest, and anywhere holding fewer than
      {MIN_FOLLOWERS_PER_COUNTRY} of your followers, are grouped into "Other countries". "Unknown" is
      followers we've seen no browsing from at all. The whole section needs at least
      {MIN_FOLLOWERS_FOR_REACH} followers to show.
    </p>
  </div>
{/if}

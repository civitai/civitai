<script lang="ts">
  import { IconChevronRight } from '@tabler/icons-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const numberFmt = new Intl.NumberFormat('en-US');
  const href = (location: string) => `/page-visits/route?location=${encodeURIComponent(location)}`;
</script>

<header class="page-header">
  <h1>Page Usage</h1>
  <p>
    {numberFmt.format(data.totalVisits)} visits across {data.routes.length} routes in the last {data.days}
    days. Least-used first — the bottom of the list (or routes missing entirely) are dead-page candidates.
  </p>
</header>

{#if data.routes.length === 0}
  <div class="placeholder">No page visits recorded yet.</div>
{:else}
  <div class="overflow-hidden rounded-xl border border-dark-4 bg-dark-6">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-dark-4 text-left text-xs uppercase tracking-wider text-dark-3">
          <th class="px-4 py-3 font-semibold">Route</th>
          <th class="px-4 py-3 text-right font-semibold">Visits</th>
          <th class="px-4 py-3 text-right font-semibold">Mods</th>
          <th class="px-4 py-3 font-semibold">Last visit</th>
          <th class="w-8"></th>
        </tr>
      </thead>
      <tbody>
        {#each data.routes as route (route.location)}
          <tr class="border-b border-dark-7/60 last:border-0 hover:bg-white/5">
            <td class="px-4 py-2.5">
              <a href={href(route.location)} class="font-mono text-blue-4">{route.location}</a>
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums text-dark-0">
              {numberFmt.format(Number(route.visits))}
            </td>
            <td class="px-4 py-2.5 text-right tabular-nums text-dark-1">
              {numberFmt.format(Number(route.distinctMods))}
            </td>
            <td class="px-4 py-2.5 font-mono text-xs text-dark-2">{route.lastVisit}</td>
            <td class="px-2">
              <a
                href={href(route.location)}
                aria-label={`Breakdown for ${route.location}`}
                class="block text-dark-3 hover:text-dark-0"
              >
                <IconChevronRight size={16} />
              </a>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

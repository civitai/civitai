<script lang="ts">
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { dateTime, LINK_CLASS } from '$lib/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const percent = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(1)}%` : '—');
</script>

<header class="page-header">
  <h1>Openings: #{data.box.id} {data.box.name}</h1>
  <a class="text-sm {LINK_CLASS}" href="/items/boxes/{data.box.id}">Back to the box</a>
</header>

<p class="mb-4 max-w-3xl text-sm text-dark-2">
  Expected counts are for opens where every tier still had something for the opener, the only opens
  whose tier odds are the version's base weights. Later opens lean to the rarer tiers by design, so
  they are counted but not compared.
</p>

{#if data.stats.length === 0}
  <p class="mb-6 text-sm text-dark-2">Nobody has opened this box yet.</p>
{/if}

{#each data.stats as version (version.version)}
  <section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-1 text-base font-semibold text-white">Version {version.version}</h2>
    <p class="mb-3 text-xs text-dark-2">
      {version.opens} opens{version.fullBoxOpens === null
        ? '; no odds snapshot for this version, so nothing to compare with'
        : `, ${version.fullBoxOpens} with every tier open`}.
    </p>
    {#if version.tiersChanged}
      <p class="mb-3 text-xs text-amber-300">
        Some of these draws are from a tier removed since, so they can't be matched to this version's
        odds. Compare by hand.
      </p>
    {/if}
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Tier</TableHead>
          <TableHead>All opens</TableHead>
          <TableHead>Every tier open: observed</TableHead>
          <TableHead>Expected</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each version.tiers as tier (tier.tierId)}
          <TableRow>
            <TableCell class="text-dark-0">{tier.name}</TableCell>
            <TableCell class="text-dark-2">{tier.observed} ({percent(tier.observed, version.opens)})</TableCell>
            <TableCell class="text-dark-2">
              {version.fullBoxOpens === null
                ? '—'
                : `${tier.fullBoxObserved} (${percent(tier.fullBoxObserved, version.fullBoxOpens)})`}
            </TableCell>
            <TableCell class="text-dark-2">
              {tier.fullBoxExpected === null || version.fullBoxOpens === null
                ? '—'
                : `${tier.fullBoxExpected.toFixed(1)} (${percent(tier.fullBoxExpected, version.fullBoxOpens)})`}
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </section>
{/each}

<h2 class="mb-2 text-base font-semibold text-white">Recent opens</h2>
{#if data.recent.length === 0}
  <p class="text-sm text-dark-2">None.</p>
{:else}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>When</TableHead>
        <TableHead>User</TableHead>
        <TableHead>Version</TableHead>
        <TableHead>Tier</TableHead>
        <TableHead>Reward</TableHead>
        <TableHead>Tier chance</TableHead>
        <TableHead>Status</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each data.recent as row (row.boxItemId)}
        <TableRow>
          <TableCell class="text-dark-2">{dateTime(row.createdAt)}</TableCell>
          <TableCell class="text-dark-2">{row.userId}</TableCell>
          <TableCell class="text-dark-2">{row.boxVersion}</TableCell>
          <TableCell class="text-dark-0">{row.tierName ?? `Removed tier #${row.tierId}`}</TableCell>
          <TableCell class="text-dark-0">{row.rewardName ?? '—'}</TableCell>
          <TableCell class="text-dark-2">
            {percent(row.tierWeight, row.eligibleWeight)} · 1 of {row.tierPoolSize}
          </TableCell>
          <TableCell class="text-dark-2">{row.rewardStatus}</TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
{/if}

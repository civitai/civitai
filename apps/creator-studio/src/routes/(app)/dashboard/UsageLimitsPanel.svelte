<script lang="ts">
  import UsageLimitMeter from '$lib/components/UsageLimitMeter.svelte';
  import { nowTick } from '$lib/now-tick.svelte';
  import {
    usageAreaName,
    windowCaption,
    type UsageLimitRow,
  } from '@civitai/shared/usage-limit-view';

  let { limits, href }: { limits: UsageLimitRow[]; href: string } = $props();

  const now = nowTick();

  const areas = $derived.by(() => {
    const byArea = new Map<string, UsageLimitRow[]>();
    for (const row of limits) byArea.set(row.area, [...(byArea.get(row.area) ?? []), row]);
    return [...byArea].map(([area, rows]) => ({ area, caption: windowCaption(rows), rows }));
  });
</script>

<section class="mb-8">
  <div class="mb-2 flex items-center justify-between">
    <p class="text-xs uppercase tracking-wide text-dark-2">Usage limits</p>
    <a {href} class="text-xs text-dark-2 hover:text-white">See all usage →</a>
  </div>
  {#if limits.length === 0}
    <p class="text-sm text-dark-2">No limits apply to you right now.</p>
  {:else}
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
      {#each areas as a (a.area)}
        <div class="cs-panel">
          <div class="flex items-center justify-between gap-2 border-b border-dark-4 px-4 py-2.5">
            <h3 class="text-sm font-semibold text-white">{usageAreaName(a.area)}</h3>
            {#if a.caption}<span class="text-xs text-dark-2">{a.caption}</span>{/if}
          </div>
          {#each a.rows as row (row.id)}
            <UsageLimitMeter {row} now={now.current} />
          {/each}
        </div>
      {/each}
    </div>
  {/if}
</section>

<script lang="ts">
  import { onMount } from 'svelte';
  import { Progress } from '@civitai/ui/components/ui/progress/index.js';
  import {
    describeUsageLimit,
    usageAreaName,
    windowCaption,
    type UsageLimitRow,
    type UsageLimitTone,
  } from '@civitai/shared/usage-limit-view';

  let { limits, href }: { limits: UsageLimitRow[]; href: string } = $props();

  const BAR: Record<UsageLimitTone, string> = {
    ok: '[&>[data-slot=progress-indicator]]:bg-blue-6',
    warn: '[&>[data-slot=progress-indicator]]:bg-orange-6',
    full: '[&>[data-slot=progress-indicator]]:bg-red-6',
    exempt: '[&>[data-slot=progress-indicator]]:bg-dark-3',
  };

  // Set after mount so the reset times are only ever drawn in the viewer's zone, never the server's.
  let now = $state<number | null>(null);
  onMount(() => {
    now = Date.now();
  });

  const areas = $derived.by(() => {
    const byArea = new Map<string, UsageLimitRow[]>();
    for (const row of limits) byArea.set(row.area, [...(byArea.get(row.area) ?? []), row]);
    return [...byArea].map(([area, rows]) => ({
      area,
      caption: windowCaption(rows),
      rows: rows.map((row) => ({ row, view: describeUsageLimit(row, { now: now ?? 0 }) })),
    }));
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
          {#each a.rows as { row, view } (row.id)}
            <div class="flex items-start gap-3 border-b border-dark-4 px-4 py-2.5 last:border-b-0">
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-dark-0">{row.label}</p>
                {#if view.percent !== null}
                  <Progress
                    value={view.percent}
                    class="mt-1.5 h-1.5 bg-dark-5 {BAR[view.tone]}"
                    aria-label="{row.label}: {view.usedText}"
                  />
                {/if}
                <p class="mt-1 text-xs text-dark-2">{view.usedText}</p>
              </div>
              {#if now !== null && (view.when || view.whenDetail)}
                <div class="shrink-0 text-right">
                  {#if view.when}<p class="text-sm font-semibold text-dark-0">{view.when}</p>{/if}
                  {#if view.whenDetail}<p class="text-xs text-dark-2">{view.whenDetail}</p>{/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    </div>
  {/if}
</section>

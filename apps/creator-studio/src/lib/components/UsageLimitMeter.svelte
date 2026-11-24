<script lang="ts">
  import { Progress } from '@civitai/ui/components/ui/progress/index.js';
  import {
    describeUsageLimit,
    type UsageLimitRow,
    type UsageLimitTone,
  } from '@civitai/shared/usage-limit-view';

  // `now` is null before mount: the bar and "x of y used" draw, the zone-dependent times wait.
  let { row, now }: { row: UsageLimitRow; now: number | null } = $props();

  const BAR: Record<UsageLimitTone, string> = {
    ok: '[&>[data-slot=progress-indicator]]:bg-blue-6',
    warn: '[&>[data-slot=progress-indicator]]:bg-orange-500',
    full: '[&>[data-slot=progress-indicator]]:bg-red-6',
    exempt: '',
  };

  const view = $derived(describeUsageLimit(row, { now: now ?? 0 }));
</script>

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

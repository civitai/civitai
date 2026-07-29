<script lang="ts">
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { recentMonths, type DateRange } from '$lib/date-range';
  import { ANALYTICS_PERIOD_COOKIE } from '$lib/analytics-period';
  import { CookieState } from '$lib/state/cookie-state.svelte';

  // Month-primary period control: pick the month to view, plus (where the page supports it) an earlier month to
  // compare against. The period is a host-only cookie (see CookieState) so it persists across tabs/sessions, stays
  // scoped to this subdomain, and updates optimistically while the loads re-run. `showCompare` false (Images/Videos)
  // hides the comparison picker.
  let {
    range,
    compare,
    showCompare = true,
  }: { range: DateRange; compare: { key: string; label: string }; showCompare?: boolean } = $props();

  const months = recentMonths(18);

  type Period = { from: string; cmp: string };
  const period = new CookieState<Period>(ANALYTICS_PERIOD_COOKIE, () => ({ from: range.from, cmp: compare.key }), {
    encode: (p) => `${p.from}|${p.cmp}`,
  });

  // Selected month/comparison as 'YYYY-MM' keys (the month is fully determined by `from`).
  const monthKey = (from: string) => from.slice(0, 7);
  const shownMonth = $derived(monthKey(period.value.from));
  const shownCompare = $derived(period.value.cmp);
  const monthLabel = $derived(months.find((m) => m.key === shownMonth)?.label ?? 'Month…');
  const compareLabel = $derived(months.find((m) => m.key === shownCompare)?.label ?? compare.label);
  // Comparison options are only months strictly earlier than the selected one.
  const compareMonths = $derived(months.filter((m) => m.key < shownMonth));

  function onMonthChange(key: string) {
    const m = months.find((x) => x.key === key);
    if (!m) return;
    // Keep the current comparison — readAnalyticsPeriod clamps it if the new month makes it invalid (>= selected).
    period.set({ from: m.range.from, cmp: period.value.cmp });
  }
  function onCompareChange(key: string) {
    period.set({ from: period.value.from, cmp: key });
  }
</script>

<div class="flex flex-wrap items-center gap-2">
  <Select.Root type="single" value={shownMonth} onValueChange={onMonthChange}>
    <Select.Trigger size="sm" class="w-36">{monthLabel}</Select.Trigger>
    <Select.Content>
      {#each months as m (m.key)}
        <Select.Item value={m.key} label={m.label} />
      {/each}
    </Select.Content>
  </Select.Root>
  {#if showCompare}
    <span class="text-xs text-dark-3">vs</span>
    <Select.Root type="single" value={shownCompare} onValueChange={onCompareChange}>
      <Select.Trigger size="sm" class="w-36">{compareLabel}</Select.Trigger>
      <Select.Content>
        {#each compareMonths as m (m.key)}
          <Select.Item value={m.key} label={m.label} />
        {/each}
      </Select.Content>
    </Select.Root>
  {/if}
</div>

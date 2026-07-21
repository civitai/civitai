<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { recentMonths, monthKey, type DateRange } from '$lib/date-range';

  // Month-primary period control: pick the month to view, plus an earlier month to compare against. The comparison
  // drives every period stat on the page (trend overlay + delta chips), matching the monthly Creator-Program model.
  let { range, compare }: { range: DateRange; compare: { key: string; label: string } } = $props();

  const months = recentMonths(18);
  const primaryKey = $derived(monthKey(range));
  const activeMonthLabel = $derived(months.find((m) => m.key === primaryKey)?.label ?? 'Month…');
  // Comparison options are only months strictly earlier than the selected one — never the selected month or later.
  const compareMonths = $derived(months.filter((m) => m.key < primaryKey));

  function navigate(mutate: (p: URLSearchParams) => void) {
    const params = new URLSearchParams(page.url.searchParams);
    mutate(params);
    goto(`?${params.toString()}`, { keepFocus: true, noScroll: true, replaceState: true });
  }
  function onMonthChange(key: string) {
    const m = months.find((x) => x.key === key);
    if (!m) return;
    // Leave ?cmp as-is — resolveCompareMonth clamps it back if the new month makes it invalid (>= selected).
    navigate((p) => {
      p.set('from', m.range.from);
      p.set('to', m.range.to);
    });
  }
  function onCompareChange(key: string) {
    navigate((p) => p.set('cmp', key));
  }
</script>

<div class="flex flex-wrap items-center gap-2" data-sveltekit-replacestate>
  <Select.Root type="single" value={primaryKey} onValueChange={onMonthChange}>
    <Select.Trigger size="sm" class="w-36">{activeMonthLabel}</Select.Trigger>
    <Select.Content>
      {#each months as m (m.key)}
        <Select.Item value={m.key} label={m.label} />
      {/each}
    </Select.Content>
  </Select.Root>
  <span class="text-xs text-dark-3">vs</span>
  <Select.Root type="single" value={compare.key} onValueChange={onCompareChange}>
    <Select.Trigger size="sm" class="w-36">{compare.label}</Select.Trigger>
    <Select.Content>
      {#each compareMonths as m (m.key)}
        <Select.Item value={m.key} label={m.label} />
      {/each}
    </Select.Content>
  </Select.Root>
</div>

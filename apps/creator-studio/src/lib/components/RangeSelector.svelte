<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { ButtonGroup } from '@civitai/ui/components/ui/button-group/index.js';
  import { RANGE_PRESETS, presetRange, recentMonths, matchesPreset, type DateRange } from '$lib/date-range';

  let { range }: { range: DateRange } = $props();

  const months = recentMonths(12);

  // Set from/to but keep whatever else is on the URL.
  function hrefFor(r: DateRange): string {
    const params = new URLSearchParams(page.url.searchParams);
    params.set('from', r.from);
    params.set('to', r.to);
    return `?${params.toString()}`;
  }

  const activePreset = $derived(RANGE_PRESETS.find((p) => matchesPreset(range, p.days))?.key ?? null);
  const activeMonth = $derived(
    months.find((m) => m.range.from === range.from && m.range.to === range.to)?.key ?? ''
  );
  const activeMonthLabel = $derived(months.find((m) => m.key === activeMonth)?.label);

  function onMonthChange(key: string) {
    const m = months.find((x) => x.key === key);
    if (m) goto(hrefFor(m.range), { keepFocus: true, noScroll: true });
  }
</script>

<div class="flex flex-wrap items-center gap-2">
  <ButtonGroup>
    {#each RANGE_PRESETS as p (p.key)}
      <Button
        href={hrefFor(presetRange(p.days))}
        size="sm"
        variant={activePreset === p.key ? 'default' : 'outline'}
      >
        {p.label}
      </Button>
    {/each}
  </ButtonGroup>
  <Select.Root type="single" value={activeMonth} onValueChange={onMonthChange}>
    <Select.Trigger size="sm" class="w-40">
      {activeMonthLabel ?? 'Month…'}
    </Select.Trigger>
    <Select.Content>
      {#each months as m (m.key)}
        <Select.Item value={m.key} label={m.label} />
      {/each}
    </Select.Content>
  </Select.Root>
</div>

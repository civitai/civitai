<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { SvelteSet } from 'svelte/reactivity';
  import { ORDER_LABELS, SWEEP_LEVELS, SWEEP_ORDERS } from '../sweep';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Local mirrors so changing a picker doesn't navigate twice. The effect re-syncs on back/forward,
  // where the component is not remounted.
  const levels = new SvelteSet<number>(untrack(() => data.nsfwLevels));
  let order = $state(untrack(() => data.order));
  let hours = $state(untrack(() => String(data.hours)));
  $effect(() => {
    const applied = data.nsfwLevels;
    untrack(() => {
      levels.clear();
      for (const l of applied) levels.add(l);
    });
    order = data.order;
    hours = String(data.hours);
  });

  // Never empty: an empty selection would fall back to the tab's default on the server, so the control
  // would show nothing while the sweep showed something.
  const toggle = (value: number) => {
    if (levels.has(value)) {
      if (levels.size > 1) levels.delete(value);
    } else levels.add(value);
  };

  // `hours` is OMITTED while the shared resume point is in force — its presence in the URL is what opts
  // out of it.
  // Query only — the path carries the media type, so this stays on the open tab.
  const apply = () =>
    goto(
      `?level=${[...levels].sort((a, b) => a - b).join(',')}&order=${order}` +
        (data.usingCheckpoint ? '' : `&hours=${hours}`),
      { keepFocus: true }
    );

</script>

<section class="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <!-- Toggle chips, sized to the inputs beside them (`h-8`, the shared Select/Button height) so the row
       reads as one control strip. Selected/unselected is the same pair the other filter bars use — the
       chip says whether it is on, not which rating it is; the label already says that.
       The chips show the PENDING selection; the heading shows what is actually loaded. -->
  <div class="flex flex-col gap-1 text-xs text-dark-2">
    Ratings
    <div class="flex flex-wrap items-center gap-1">
      {#each SWEEP_LEVELS as l (l.value)}
        {@const on = levels.has(l.value)}
        <button
          type="button"
          onclick={() => toggle(l.value)}
          aria-pressed={on}
          title={l.description}
          class={cn(
            'h-8 rounded-lg border px-2.5 text-sm font-medium transition-colors',
            on
              ? 'border-primary bg-primary/15 text-white'
              : 'border-input text-dark-2 hover:bg-dark-5 hover:text-dark-0'
          )}
        >
          {l.label}
        </button>
      {/each}
    </div>
  </div>

  <label class="flex flex-col gap-1 text-xs text-dark-2">
    Order
    <Select.Root type="single" bind:value={order}>
      <Select.Trigger class="w-56">{ORDER_LABELS[order]}</Select.Trigger>
      <Select.Content>
        {#each SWEEP_ORDERS as o (o)}
          <Select.Item value={o}>{ORDER_LABELS[o]}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </label>

  <!-- Hidden while the shared point is in force: it is not the window that is running, and a control
       showing 24h over a five-day window states something false. -->
  {#if order === 'newest' && !data.usingCheckpoint}
    <label class="flex flex-col gap-1 text-xs text-dark-2">
      Window (hours)
      <Select.Root type="single" bind:value={hours}>
        <Select.Trigger class="w-28">{hours}h</Select.Trigger>
        <Select.Content>
          {#each [6, 12, 24, 48, 72, 168, 720] as h (h)}
            <Select.Item value={String(h)}>{h}h</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </label>
  {/if}

  <Button onclick={apply}>Sweep</Button>
</section>

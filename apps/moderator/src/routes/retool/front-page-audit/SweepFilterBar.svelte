<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { MEDIA_LABELS, ORDER_LABELS, SWEEP_LEVELS, SWEEP_MEDIA, SWEEP_ORDERS } from './sweep';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Local mirrors so changing a picker doesn't navigate twice. The effect re-syncs on back/forward,
  // where the component is not remounted.
  let level = $state(untrack(() => String(data.nsfwLevel)));
  let order = $state(untrack(() => data.order));
  let media = $state(untrack(() => data.media));
  let hours = $state(untrack(() => String(data.hours)));
  $effect(() => {
    level = String(data.nsfwLevel);
    order = data.order;
    media = data.media;
    hours = String(data.hours);
  });

  // `hours` is OMITTED while the shared resume point is in force — its presence in the URL is what opts
  // out of it.
  const apply = () =>
    goto(
      `?level=${level}&order=${order}&media=${media}` +
        (data.usingCheckpoint ? '' : `&hours=${hours}`),
      { keepFocus: true }
    );

  // The picker shows the PENDING selection; the heading shows what is actually loaded. Labelling the
  // control from `data` made a chosen value read as unchanged until Sweep was pressed.
  const pendingLevelLabel = $derived(
    SWEEP_LEVELS.find((l) => l.value === Number(level))?.label ?? level
  );
</script>

<section class="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <label class="flex flex-col gap-1 text-xs text-dark-2">
    Rating
    <Select.Root type="single" bind:value={level}>
      <Select.Trigger class="w-32">{pendingLevelLabel}</Select.Trigger>
      <Select.Content>
        {#each SWEEP_LEVELS as l (l.value)}
          <Select.Item value={String(l.value)}>{l.label}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </label>

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

  <label class="flex flex-col gap-1 text-xs text-dark-2">
    Media
    <Select.Root type="single" bind:value={media}>
      <Select.Trigger class="w-32">{MEDIA_LABELS[media]}</Select.Trigger>
      <Select.Content>
        {#each SWEEP_MEDIA as m (m)}
          <Select.Item value={m}>{MEDIA_LABELS[m]}</Select.Item>
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

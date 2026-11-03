<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { urlWith } from '$lib/url';
  import { CURRENT_LEVELS, DAY_OPTIONS, SOURCES, type Filters } from '$lib/shadow-sexual-prompt';

  let { filters }: { filters: Filters } = $props();

  // Any filter change restarts paging: `page` counts into the set being replaced.
  const navigate = (params: Record<string, string>) =>
    goto(urlWith(page.url, { page: null, ...params }), { keepFocus: true, noScroll: true });

  const sourceLabel = $derived(SOURCES.find(([v]) => v === filters.source)?.[1]);
  const currentLabel = $derived(CURRENT_LEVELS.find(([v]) => v === filters.current)?.[1]);
</script>

<div class="mb-5 flex flex-wrap items-end gap-3">
  <div>
    <Label for="ssp-days" class="text-xs text-dark-2">Window</Label>
    <Select.Root type="single" bind:value={() => String(filters.days), (v) => navigate({ days: v })}>
      <Select.Trigger id="ssp-days" class="mt-1 w-36">Last {filters.days} days</Select.Trigger>
      <Select.Content>
        {#each DAY_OPTIONS as days (days)}
          <Select.Item value={String(days)}>Last {days} days</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  <div>
    <Label for="ssp-source" class="text-xs text-dark-2">Source</Label>
    <Select.Root type="single" bind:value={() => filters.source, (v) => navigate({ source: v })}>
      <Select.Trigger id="ssp-source" class="mt-1 w-52">{sourceLabel}</Select.Trigger>
      <Select.Content>
        {#each SOURCES as [value, label] (value)}
          <Select.Item {value}>{label}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  <div>
    <Label for="ssp-current" class="text-xs text-dark-2">Would-raise list: level at scan</Label>
    <Select.Root type="single" bind:value={() => filters.current, (v) => navigate({ current: v })}>
      <Select.Trigger id="ssp-current" class="mt-1 w-52">{currentLabel}</Select.Trigger>
      <Select.Content>
        {#each CURRENT_LEVELS as [value, label] (value)}
          <Select.Item {value}>{label}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
</div>

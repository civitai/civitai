<script lang="ts">
  import { goto } from '$app/navigation';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { urlWith } from '$lib/url';

  let {
    items,
    itemId,
    url,
  }: { items: { id: number; name: string }[]; itemId: string; url: URL } = $props();

  const ALL = 'All items';
</script>

<div class="flex items-center gap-2 text-sm text-dark-2">
  Item
  <Select.Root
    type="single"
    bind:value={
      () => itemId, (value) => void goto(urlWith(url, { item: value, before: null }), { keepFocus: true })
    }
  >
    <Select.Trigger class="w-64" aria-label="Filter by item">
      {items.find((item) => String(item.id) === itemId)?.name ?? ALL}
    </Select.Trigger>
    <Select.Content>
      <Select.Item value="">{ALL}</Select.Item>
      {#each items as item (item.id)}
        <Select.Item value={String(item.id)}>{item.name}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
</div>

<script lang="ts">
  import { untrack } from 'svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';

  let { items, itemId }: { items: { id: string; name: string }[]; itemId: string } = $props();

  let selected = $state(untrack(() => itemId));
  const ALL = 'All items';
</script>

<form method="GET" class="mb-4 flex items-center gap-2 text-sm text-dark-2">
  <input type="hidden" name="tab" value="audit" />
  <input type="hidden" name="item" value={selected} />
  <label class="flex items-center gap-2">
    Item
    <Select.Root type="single" bind:value={selected}>
      <Select.Trigger class="w-56">
        {items.find((item) => item.id === selected)?.name ?? ALL}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="">{ALL}</Select.Item>
        {#each items as item (item.id)}
          <Select.Item value={item.id}>{item.name}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </label>
  <Button type="submit" size="sm">Filter</Button>
</form>

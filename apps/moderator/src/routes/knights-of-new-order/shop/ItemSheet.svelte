<script lang="ts">
  import * as Sheet from '@civitai/ui/components/ui/sheet/index.js';
  import { Tabs, TabsContent, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import type { ShopItemRow } from '$lib/server/knights/shop-catalog.service';
  import ItemForm from './ItemForm.svelte';
  import ItemHistory from './ItemHistory.svelte';
  import type { SheetTarget, Today } from './shop-view';

  let {
    target = $bindable(null),
    seq,
    items,
    ranks,
    day,
    today,
    onstatus,
  }: {
    target?: SheetTarget | null;
    /** Bumped by the page on every open, so a reopened sheet remounts its form even mid-close-animation. */
    seq: number;
    items: readonly ShopItemRow[];
    ranks: readonly string[];
    day: string;
    today: Today;
    onstatus: (item: ShopItemRow, action: 'retire' | 'restore') => void;
  } = $props();

  // The sheet animates out after `target` goes null; keep the last one so the content does not blank mid-close.
  let last: SheetTarget = { mode: 'create' };
  const shown = $derived.by(() => {
    if (target) last = target;
    return last;
  });
  const item = $derived(
    shown.mode === 'edit' ? (items.find((row) => row.id === shown.id) ?? null) : null
  );
  const close = () => (target = null);
</script>

<Sheet.Root bind:open={() => target !== null, (open) => !open && close()}>
  <Sheet.Content
    side="right"
    class="overflow-y-auto p-5 data-[side=right]:w-full data-[side=right]:sm:max-w-4xl"
  >
    <Sheet.Header class="p-0">
      <Sheet.Title class="text-white">
        {shown.mode === 'create' ? 'Add an item' : (item?.name ?? 'Item')}
      </Sheet.Title>
      <Sheet.Description class="text-dark-2">
        {shown.mode === 'create'
          ? 'Pick what it is, then price it. It goes on sale on the next request.'
          : 'Changes go live on the next request and are recorded in the audit trail.'}
      </Sheet.Description>
    </Sheet.Header>
    {#key `${seq}:${shown.mode === 'edit' ? shown.id : 'new'}`}
      {#if shown.mode === 'create'}
        <ItemForm item={null} {items} {ranks} {day} {today} ondone={close} onstatus={() => {}} />
      {:else if !item}
        <p class="text-sm text-dark-2">That item no longer exists.</p>
      {:else}
        <Tabs
          value={shown.tab}
          onValueChange={(tab) =>
            (target = { mode: 'edit', id: item.id, tab: tab === 'history' ? 'history' : 'details' })}
        >
          <TabsList class="mb-4">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent value="details">
            <ItemForm
              {item}
              {items}
              {ranks}
              {day}
              {today}
              ondone={close}
              onstatus={(action) => onstatus(item, action)}
            />
          </TabsContent>
          <TabsContent value="history"><ItemHistory itemId={item.id} /></TabsContent>
        </Tabs>
      {/if}
    {/key}
  </Sheet.Content>
</Sheet.Root>

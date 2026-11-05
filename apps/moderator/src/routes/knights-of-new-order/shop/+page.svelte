<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { num } from '$lib/format';
  import AddItemForm from './AddItemForm.svelte';
  import ShopItemCard from './ShopItemCard.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const tabs = $derived([
    { value: 'items', label: `Items (${data.items.length})`, href: '?tab=items' },
    { value: 'preview', label: 'Preview', href: '?tab=preview' },
    { value: 'audit', label: 'Audit', href: '?tab=audit' },
  ]);

  const stamp = (value: Date | string) =>
    `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const show = (value: unknown) => (value === null || value === undefined ? 'none' : String(value));
</script>

<header class="page-header">
  <h1>Knights of New Order Shop</h1>
  <p>
    The gold shop catalog. Every edit is live on the next request and recorded in the audit tab.
    Items are retired rather than deleted, because purchases point at them. To change what an item
    is (its Buzz, cosmetic, tier or months), retire it and add a new one.
  </p>
</header>

<LinkTabs class="mb-4" items={tabs} active={data.tab} />

{#if data.tab === 'items'}
  <AddItemForm />
  <div class="flex flex-col gap-3">
    {#each data.items as item (item.id)}
      <ShopItemCard {item} />
    {:else}
      <p class="text-sm text-dark-2">The catalog is empty. Add an item above.</p>
    {/each}
  </div>
{:else if data.tab === 'preview' && data.preview}
  <form method="GET" class="mb-4 flex items-center gap-2 text-sm text-dark-2">
    <input type="hidden" name="tab" value="preview" />
    <label class="flex items-center gap-2">
      UTC day <Input type="date" name="day" value={data.day} class="w-44" />
    </label>
    <Button type="submit" size="sm">Show</Button>
  </form>
  <p class="mb-3 text-sm text-dark-2">
    What the shop sells on {data.preview.day}: active items the main app can sell, with the daily
    rotation and deals drawn by the same code Knights runs.
  </p>
  <div class="flex flex-col gap-2">
    {#each data.preview.stock as entry (entry.item.id)}
      <div class="flex flex-wrap items-center gap-2 rounded-md border border-dark-4 bg-dark-6 p-3 text-sm">
        <span class="font-medium">{entry.item.name}</span>
        <Badge variant="secondary">{entry.item.kind.replace('_', ' ')}</Badge>
        {#if entry.item.rotating}<Badge variant="outline">Rotating</Badge>{/if}
        {#if entry.deal}<Badge>Deal</Badge>{/if}
        <span class="ml-auto">
          {#if entry.deal}<s class="text-dark-2">{num(entry.item.price)}</s>{/if}
          {num(entry.price)} gold
        </span>
      </div>
    {:else}
      <p class="text-sm text-dark-2">Nothing would be on sale.</p>
    {/each}
  </div>
  {#if data.preview.excluded.length}
    <p class="mt-4 text-sm text-dark-2">
      Active but never sold, because the main app sells memberships one month at a time:
      {data.preview.excluded.map((item) => `${item.name} (${item.months} months)`).join(', ')}.
    </p>
  {/if}
{:else if data.tab === 'audit'}
  <form method="GET" class="mb-4 flex items-center gap-2 text-sm text-dark-2">
    <input type="hidden" name="tab" value="audit" />
    <label class="flex items-center gap-2">
      Item
      <select
        name="item"
        value={data.itemId}
        class="h-8 rounded-md border bg-background px-2 text-sm"
      >
        <option value="">All items</option>
        {#each data.items as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
      </select>
    </label>
    <Button type="submit" size="sm">Filter</Button>
  </form>
  <div class="flex flex-col gap-2">
    {#each data.changes as change (change.id)}
      <div class="rounded-md border border-dark-4 bg-dark-6 p-3 text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{change.action}</Badge>
          <span class="font-medium">{change.itemName}</span>
          <span class="text-dark-2">
            by {change.moderatorUsername ?? `user #${change.moderatorId}`}, {stamp(change.createdAt)}
          </span>
        </div>
        <ul class="mt-1 text-dark-2">
          {#each Object.entries(change.changes) as [field, { from, to }] (field)}
            <li>{field}: {show(from)} &rarr; {show(to)}</li>
          {/each}
        </ul>
      </div>
    {:else}
      <p class="text-sm text-dark-2">No changes recorded yet.</p>
    {/each}
  </div>
{/if}

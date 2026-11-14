<script lang="ts">
  import { page } from '$app/state';
  import { IconPlus } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import type { ShopItemRow } from '$lib/server/knights/shop-catalog.service';
  import AuditView from './AuditView.svelte';
  import ItemSheet from './ItemSheet.svelte';
  import ItemsView from './ItemsView.svelte';
  import PreviewView from './PreviewView.svelte';
  import StatusDialog from './StatusDialog.svelte';
  import { todayOf, type SheetTarget, type StatusTarget } from './shop-view';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let sheet = $state<SheetTarget | null>(null);
  let sheetSeq = $state(0);
  let status = $state<StatusTarget | null>(null);

  const tabs = $derived([
    { value: 'items', label: `Items (${data.items.length})`, href: '?tab=items' },
    { value: 'preview', label: 'Preview', href: '?tab=preview' },
    { value: 'audit', label: 'Audit', href: '?tab=audit' },
  ]);
  const today = $derived(todayOf(data.todayStock));

  const open = (target: SheetTarget) => {
    sheetSeq++;
    sheet = target;
  };
  const openEdit = (id: number, tab: 'details' | 'history' = 'details') =>
    open({ mode: 'edit', id, tab });
  const askStatus = (item: ShopItemRow, action: 'retire' | 'restore') => (status = { item, action });
</script>

<div class="mb-7 flex flex-wrap items-start justify-between gap-3">
  <header class="page-header mb-0">
    <h1>Knights of New Order Shop</h1>
    <p>Gold shop catalog · edits go live on the next request</p>
  </header>
  <Button onclick={() => open({ mode: 'create' })}>
    <IconPlus />
    Add item
  </Button>
</div>

<LinkTabs class="mb-4" items={tabs} active={data.tab} />

{#if data.tab === 'items'}
  <ItemsView
    items={data.items}
    query={data.query}
    entries={data.todayStock}
    day={data.today}
    now={data.now}
    url={page.url}
    onadd={() => open({ mode: 'create' })}
    onedit={(id) => openEdit(id)}
    onhistory={(id) => openEdit(id, 'history')}
    onstatus={askStatus}
  />
{:else if data.tab === 'preview' && data.preview}
  <PreviewView preview={data.preview} today={data.today} url={page.url} />
{:else if data.tab === 'audit'}
  <AuditView
    items={data.items}
    itemId={data.itemId}
    before={data.before}
    nextBefore={data.nextBefore}
    changes={data.changes}
    url={page.url}
    onopenitem={(id) => openEdit(id)}
  />
{/if}

<ItemSheet
  bind:target={sheet}
  seq={sheetSeq}
  items={data.items}
  ranks={data.ranks}
  day={data.today}
  {today}
  onstatus={askStatus}
/>
<StatusDialog bind:target={status} items={data.items} day={data.today} onsettled={() => (sheet = null)} />

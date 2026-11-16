<script lang="ts">
  import { onDestroy } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { IconPackage, IconSearch } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Empty from '@civitai/ui/components/ui/empty/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import {
    Table,
    TableBody,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { num } from '$lib/format';
  import { urlWith } from '$lib/url';
  import type { ShopItemRow } from '$lib/server/knights/shop-catalog.service';
  import ItemRow from './ItemRow.svelte';
  import TodayStrip from './TodayStrip.svelte';
  import {
    KIND_GROUP,
    KIND_ORDER,
    filterItems,
    groupByKind,
    isKind,
    statusCounts,
    todayOf,
    type Kind,
    type Query,
    type TodayEntry,
  } from './shop-view';

  let {
    items,
    query,
    entries,
    day,
    now,
    url,
    onadd,
    onedit,
    onhistory,
    onstatus,
  }: {
    items: readonly ShopItemRow[];
    query: Query;
    entries: readonly TodayEntry[];
    day: string;
    now: string;
    url: URL;
    onadd: () => void;
    onedit: (id: number) => void;
    onhistory: (id: number) => void;
    onstatus: (item: ShopItemRow, action: 'retire' | 'restore') => void;
  } = $props();

  const ANY_KIND = 'all';
  // What the operator typed; null until they type, and again after back/forward, so the URL's q wins.
  let typed = $state<string | null>(null);
  let typing: ReturnType<typeof setTimeout>;
  const q = $derived(typed ?? query.q);
  // The page URL as the list currently reads, so a tab or kind link never drops a search still in its debounce.
  const current = $derived(new URL(urlWith(url, { q: q.trim() || null }), url));

  afterNavigate(({ type }) => {
    if (type === 'popstate') typed = null;
  });
  onDestroy(() => clearTimeout(typing));

  const filters = $derived({ ...query, q });
  const shown = $derived(filterItems(items, filters));
  const groups = $derived(groupByKind(shown));
  const counts = $derived(statusCounts(items));
  const today = $derived(todayOf(entries));
  const filtered = $derived(q !== '' || query.status !== 'live' || query.kind !== '');

  const statusItems = $derived(
    (
      [
        ['live', `Live ${counts.live}`],
        ['retired', `Retired ${counts.retired}`],
        ['all', `All ${counts.all}`],
      ] as const
    ).map(([value, label]) => ({
      value,
      label,
      href: urlWith(current, { status: value === 'live' ? null : value }),
    }))
  );

  function search(value: string) {
    typed = value;
    clearTimeout(typing);
    typing = setTimeout(
      () =>
        void goto(urlWith(url, { q: value.trim() || null }), {
          replaceState: true,
          keepFocus: true,
          noScroll: true,
        }),
      300
    );
  }
  function clear() {
    clearTimeout(typing);
    typed = '';
    void goto(urlWith(url, { q: null, status: null, kind: null }), { keepFocus: true });
  }
</script>

{#if items.length === 0}
  <Empty.Root class="rounded-xl border border-dashed border-dark-4 bg-dark-6 py-14">
    <Empty.Header>
      <Empty.Media variant="icon"><IconPackage /></Empty.Media>
      <Empty.Title>The shop has nothing to sell yet</Empty.Title>
      <Empty.Description>
        Add Buzz packs, memberships and cosmetics for Knights to spend their gold on.
      </Empty.Description>
    </Empty.Header>
    <Empty.Content>
      <Button onclick={onadd}>Add your first item</Button>
    </Empty.Content>
  </Empty.Root>
{:else}
  <TodayStrip {items} {entries} {day} {now} />

  <section class="@container rounded-xl border border-dark-4 bg-dark-6 p-4">
    <div class="mb-2 flex flex-wrap items-center gap-3">
      <div class="relative">
        <IconSearch class="pointer-events-none absolute top-2 left-2.5 size-4 text-dark-2" />
        <Input
          value={q}
          oninput={(e) => search(e.currentTarget.value)}
          placeholder="Search name, #id or cosmetic"
          class="w-64 pl-8"
          aria-label="Search items"
        />
      </div>
      <LinkTabs items={statusItems} active={query.status} />
      <Select.Root
        type="single"
        bind:value={
          () => query.kind || ANY_KIND,
          (value) =>
            void goto(urlWith(current, { kind: isKind(value) ? value : null }), { keepFocus: true })
        }
      >
        <Select.Trigger class="w-40" aria-label="Kind">
          {query.kind ? KIND_GROUP[query.kind] : 'Kind: All'}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value={ANY_KIND}>All kinds</Select.Item>
          {#each KIND_ORDER as kind (kind)}
            <Select.Item value={kind}>{KIND_GROUP[kind]}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <span class="text-sm text-dark-2">{num(shown.length)} of {num(items.length)}</span>
      <a class="ml-auto text-sm text-blue-4 hover:underline" href="?tab=audit">Audit →</a>
    </div>

    {#if !shown.length}
      <Empty.Root class="py-10">
        <Empty.Header>
          <Empty.Media variant="icon"><IconSearch /></Empty.Media>
          <Empty.Title>No items match</Empty.Title>
          <Empty.Description>Nothing in the catalog fits these filters.</Empty.Description>
        </Empty.Header>
        {#if filtered}
          <Empty.Content>
            <Button variant="outline" onclick={clear}>Clear filters</Button>
          </Empty.Content>
        {/if}
      </Empty.Root>
    {/if}

    {#each groups as group (group.kind)}
      <h3 class="mt-4 mb-1 text-xs font-semibold uppercase tracking-wide text-dark-2">
        {KIND_GROUP[group.kind as Kind]}
        <span class="font-normal">· {group.items.length}</span>
      </h3>
      <Table class="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead class="w-14"><span class="sr-only">Picture</span></TableHead>
            <TableHead class="min-w-40">Item</TableHead>
            <TableHead class="w-24 text-right">Price</TableHead>
            <TableHead class="hidden w-64 @4xl:table-cell">Availability</TableHead>
            <TableHead class="hidden w-28 @4xl:table-cell">Open to</TableHead>
            <TableHead class="w-28"><span class="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each group.items as item (item.id)}
            <ItemRow
              {item}
              {today}
              onedit={() => onedit(item.id)}
              onhistory={() => onhistory(item.id)}
              onstatus={(action) => onstatus(item, action)}
            />
          {/each}
        </TableBody>
      </Table>
    {/each}
  </section>
{/if}

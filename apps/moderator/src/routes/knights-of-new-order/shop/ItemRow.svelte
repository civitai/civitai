<script lang="ts">
  import { IconDots, IconHistory, IconLock } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as DropdownMenu from '@civitai/ui/components/ui/dropdown-menu/index.js';
  import { TableCell, TableRow } from '@civitai/ui/components/ui/table/index.js';
  import { num } from '$lib/format';
  import AvailabilityBadge from './AvailabilityBadge.svelte';
  import ItemThumb from './ItemThumb.svelte';
  import { availability, rankLabel, secondaryLine, type Kind, type Today } from './shop-view';
  import type { ShopItemRow } from '$lib/server/knights/shop-catalog.service';

  let {
    item,
    today,
    onedit,
    onhistory,
    onstatus,
  }: {
    item: ShopItemRow;
    today: Today;
    onedit: () => void;
    onhistory: () => void;
    onstatus: (action: 'retire' | 'restore') => void;
  } = $props();

  const status = $derived(availability(item, today));
  const secondary = $derived(secondaryLine(item));
</script>

<TableRow class={item.active ? '' : 'opacity-70'}>
  <TableCell class="w-14">
    <ItemThumb
      kind={item.kind as Kind}
      name={item.name}
      tier={item.tier}
      cosmeticType={item.cosmeticType}
      cosmeticData={item.cosmeticData}
    />
  </TableCell>
  <TableCell>
    <div class="flex min-w-0 flex-col gap-0.5">
      <div class="flex min-w-0 items-baseline gap-2">
        <button
          type="button"
          class="min-w-0 truncate text-left font-medium text-white hover:underline"
          onclick={onedit}>{item.name}</button
        >
        <span class="shrink-0 text-xs text-dark-2">#{item.id}</span>
      </div>
      {#if secondary}<span class="truncate text-xs text-dark-2">{secondary}</span>{/if}
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 @4xl:hidden">
        <AvailabilityBadge availability={status} />
        {#if item.minRank}
          <span class="inline-flex items-center gap-1 text-xs text-dark-2">
            <IconLock class="size-3" />{rankLabel(item.minRank)}
          </span>
        {/if}
      </div>
    </div>
  </TableCell>
  <TableCell class="text-right tabular-nums text-dark-0">{num(item.price)} g</TableCell>
  <TableCell class="hidden @4xl:table-cell"><AvailabilityBadge availability={status} /></TableCell>
  <TableCell class="hidden text-sm text-dark-2 @4xl:table-cell">{rankLabel(item.minRank)}</TableCell>
  <TableCell class="w-28 text-right">
    <div class="flex items-center justify-end gap-1">
      <Button size="sm" variant="outline" onclick={onedit}>Edit</Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} size="icon-sm" variant="ghost" aria-label="More actions for {item.name}">
              <IconDots />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Item onSelect={onhistory}><IconHistory />History</DropdownMenu.Item>
          <DropdownMenu.Separator />
          {#if item.active}
            <DropdownMenu.Item variant="destructive" onSelect={() => onstatus('retire')}>
              Retire
            </DropdownMenu.Item>
          {:else}
            <DropdownMenu.Item onSelect={() => onstatus('restore')}>Restore</DropdownMenu.Item>
          {/if}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  </TableCell>
</TableRow>

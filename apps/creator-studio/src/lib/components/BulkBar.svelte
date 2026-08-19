<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as DropdownMenu from '@civitai/ui/components/ui/dropdown-menu/index.js';
  import { IconChevronDown } from '@tabler/icons-svelte';
  import type { BulkAction } from '$lib/monetization/bulk-actions';

  let {
    count,
    matchingCount,
    allMatchingSelected,
    offViewCount,
    exportHref,
    onAction,
    salesEnabled = false,
    onSelectAllMatching,
    onClear,
  }: {
    count: number;
    matchingCount: number;
    allMatchingSelected: boolean;
    offViewCount: number;
    exportHref: string;
    onAction: (action: BulkAction) => void;
    /** Scheduled sales are behind a flag; the bar must not offer what the action would refuse. */
    salesEnabled?: boolean;
    onSelectAllMatching: () => void;
    onClear: () => void;
  } = $props();

  const has = $derived(count > 0);
  const allMatching = $derived(allMatchingSelected && matchingCount > 0);
  const showOffView = $derived(has && offViewCount > 0);
</script>

<div
  class="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-dark-4 bg-dark-6 px-3 py-2"
>
  <Checkbox
    id="bulk-select-all"
    checked={allMatching}
    indeterminate={has && !allMatching}
    disabled={matchingCount === 0 && !has}
    onCheckedChange={() => (has ? onClear() : onSelectAllMatching())}
    aria-label={has ? 'Clear selection' : `Select all ${matchingCount} versions matching filters`}
  />
  <Label for="bulk-select-all" class="cursor-pointer text-sm font-medium text-white">
    {#if has}
      {count} selected
    {:else}
      Select all {matchingCount}
    {/if}
  </Label>
  {#if showOffView}
    <span class="text-xs text-yellow-4">
      {offViewCount} no longer {offViewCount === 1 ? 'matches' : 'match'} your filters
    </span>
  {/if}

  <span class="mx-1 h-5 w-px bg-dark-4" aria-hidden="true"></span>

  <Button variant="outline" size="sm" disabled={!has} onclick={() => onAction('fee')}>
    Licensing fee
  </Button>
  <Button variant="outline" size="sm" disabled={!has} onclick={() => onAction('paidAccess')}>
    Paid access
  </Button>
  <Button variant="outline" size="sm" disabled={!has} onclick={() => onAction('usageControl')}>
    Usage control
  </Button>

  <DropdownMenu.Root>
    <DropdownMenu.Trigger disabled={!has}>
      {#snippet child({ props })}
        <Button {...props} variant="outline" size="sm" disabled={!has}>
          More <IconChevronDown size={14} />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="start" class="w-56">
      <DropdownMenu.Group>
        <DropdownMenu.GroupHeading>Set</DropdownMenu.GroupHeading>
        <DropdownMenu.Item onSelect={() => onAction('fee')}>Licensing fee…</DropdownMenu.Item>
        <DropdownMenu.Item onSelect={() => onAction('paidAccess')}>Paid access…</DropdownMenu.Item>
        {#if salesEnabled}
          <DropdownMenu.Item onSelect={() => onAction('scheduleSale')}>
            Schedule a sale…
          </DropdownMenu.Item>
        {/if}
        <DropdownMenu.Item onSelect={() => onAction('usageControl')}>
          Usage control…
        </DropdownMenu.Item>
      </DropdownMenu.Group>
      <DropdownMenu.Separator />
      <DropdownMenu.Group>
        <DropdownMenu.GroupHeading>Remove</DropdownMenu.GroupHeading>
        <DropdownMenu.Item variant="destructive" onSelect={() => onAction('clearFee')}>
          Clear licensing fee…
        </DropdownMenu.Item>
        <DropdownMenu.Item variant="destructive" onSelect={() => onAction('removeAccess')}>
          Remove paid access…
        </DropdownMenu.Item>
      </DropdownMenu.Group>
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  <div class="ml-auto">
    <Button href={exportHref} data-sveltekit-reload variant="outline" size="sm">Export CSV</Button>
  </div>
</div>

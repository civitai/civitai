<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import type { TicketPageResult } from '$lib/server/tickets/list';
  import type { TicketView } from '$lib/tickets/routing';
  import {
    SORT_OPTIONS,
    clearFiltersHref,
    optionText,
    parseSortValue,
    sentOptions,
    sortValue,
    statusOptions,
    valueOptions,
    visibleFilters,
  } from '$lib/tickets/filters';
  import { urlWith } from '$lib/url';
  import TicketFilterMenu from './TicketFilterMenu.svelte';

  type Ok = Extract<TicketPageResult, { status: 'ok' }>;

  let {
    view,
    result,
    dropOnChange,
  }: {
    view: TicketView;
    result: Ok;
    /** Params that index the old result set (page, open ticket) and go with any change. */
    dropOnChange: readonly string[];
  } = $props();

  const query = $derived(result.query);
  const shown = $derived(visibleFilters(view));
  const sent = $derived(sentOptions(result.facets.sent));
  const sentCurrent = $derived(sent.find((o) => o.value === (query.sent ?? '')) ?? sent[0]);
  const sortCurrent = $derived(sortValue(query.sort, query.dir));
  // Any filter in the URL counts, shown or not: a hidden one still narrows the list.
  const filtersActive = $derived(
    query.status.length > 0 ||
      query.feature.length > 0 ||
      query.topic.length > 0 ||
      query.sent !== undefined
  );

  const go = (href: string) => void goto(href, { noScroll: true, keepFocus: true });

  function pickSent(value: string) {
    const params: Record<string, string | null> = { sent: value || null };
    for (const key of dropOnChange) params[key] = null;
    go(urlWith(page.url, params));
  }

  function pickSort(value: string) {
    const { sort, dir } = parseSortValue(value);
    const params: Record<string, string | null> = {
      sort: sort === 'updated' ? null : sort,
      dir: dir === 'desc' ? null : dir,
    };
    for (const key of dropOnChange) params[key] = null;
    go(urlWith(page.url, params));
  }
</script>

<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
  {#if shown.includes('status')}
    <TicketFilterMenu
      param="status"
      label="Status"
      options={statusOptions(query.status, result.facets.status)}
      {dropOnChange}
    />
  {/if}
  {#if shown.includes('feature')}
    <TicketFilterMenu
      param="feature"
      label="Feature"
      options={valueOptions(query.feature, result.facets.feature, 'No feature')}
      {dropOnChange}
    />
  {/if}
  {#if shown.includes('topic')}
    <TicketFilterMenu
      param="topic"
      label="Router topic"
      options={valueOptions(query.topic, result.facets.topic, 'No topic')}
      {dropOnChange}
    />
  {/if}
  {#if shown.includes('sent')}
    <Select.Root type="single" bind:value={() => query.sent ?? '', pickSent}>
      <Select.Trigger
        size="sm"
        class="h-7 border-dark-4 text-xs"
        aria-label="Sent to support"
      >
        {query.sent === undefined ? 'Sent to support' : `Sent · ${sentCurrent.label}`}
      </Select.Trigger>
      <Select.Content>
        {#each sent as option (option.value)}
          <Select.Item value={option.value} label={option.label}>
            {optionText(option)}
          </Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  {/if}
  {#if filtersActive}
    <Button size="xs" variant="ghost" onclick={() => go(clearFiltersHref(page.url, dropOnChange))}>
      Clear
    </Button>
  {/if}
  <div class="ml-auto">
    <Select.Root type="single" bind:value={() => sortCurrent, pickSort}>
      <Select.Trigger size="sm" class="h-7 border-dark-4 text-xs" aria-label="Sort">
        {SORT_OPTIONS.find((o) => o.value === sortCurrent)?.label}
      </Select.Trigger>
      <Select.Content align="end">
        {#each SORT_OPTIONS as option (option.value)}
          <Select.Item value={option.value} label={option.label} />
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
</div>

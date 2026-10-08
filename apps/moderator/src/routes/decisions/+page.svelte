<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import DecisionStoreNotice from '$lib/components/DecisionStoreNotice.svelte';
  import NumberedPager from '$lib/components/NumberedPager.svelte';
  import { versionedHref } from '$lib/decisions';
  import { num } from '$lib/format';
  import { urlWith } from '$lib/url';
  import HeaderStrip from './HeaderStrip.svelte';
  import InboxTable from './InboxTable.svelte';
  import { PAGE_SIZE, STATE_FILTERS } from './inbox';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const ALL_AREAS = '__all__';

  /** Every filter change resets paging, per the URL filtering pattern. */
  const filterUrl = (params: Record<string, string | null>) =>
    urlWith(page.url, { ...params, page: null });

  const STATE_LABEL: Record<(typeof STATE_FILTERS)[number], string> = {
    unruled: 'Unruled',
    ruled: 'Ruled',
    escalated: 'Escalated',
    resolved: 'Resolved',
    all: 'All',
  };

  const areaLabel = $derived(data.filters.topic || 'All areas');
  const groupHref = (groupKey: string) =>
    versionedHref(`/decisions/support/${groupKey}`, data.version, data.overridden);
</script>

<header class="page-header">
  <h1>Decisions</h1>
  <p class="text-dark-2">
    Items waiting on a human ruling, by source. The support router groups tickets that ask the same
    thing — a question with an established answer, or a known issue reported many times — so one
    ruling can cover the whole group.
  </p>
</header>

{#if data.sourceStatus === 'unreachable'}
  <p class="text-dark-2">
    Could not read the support-ticket router's data. The server log has the error.
  </p>
{:else if data.sourceStatus === 'empty'}
  <p class="text-dark-2">The support-ticket router has not written any groups yet.</p>
{:else}
  {#if data.header}
    <HeaderStrip header={data.header} overridden={data.overridden} />
  {/if}

  <DecisionStoreNotice status={data.storeStatus} />

  <div class="mb-4 flex flex-wrap items-end gap-x-6 gap-y-3">
    <div class="flex flex-col gap-1">
      <span class="text-xs font-medium text-dark-2">Source</span>
      <!-- One source in v1; shown so the inbox reads as source-agnostic, not as a router page. -->
      <Badge variant="outline">Support tickets</Badge>
    </div>
    <div class="flex flex-col gap-1">
      <span class="text-xs font-medium text-dark-2">Area</span>
      <Select.Root
        type="single"
        value={data.filters.topic || ALL_AREAS}
        onValueChange={(v) => goto(filterUrl({ topic: v === ALL_AREAS ? null : v }))}
      >
        <Select.Trigger class="w-56">{areaLabel}</Select.Trigger>
        <Select.Content>
          <Select.Item value={ALL_AREAS}>All areas</Select.Item>
          {#each data.topics as t (t.topic)}
            <Select.Item value={t.topic}>{t.topic} ({num(t.groups)})</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    <div class="flex flex-col gap-1">
      <span class="text-xs font-medium text-dark-2">State</span>
      <Tabs value={data.filters.state} onValueChange={(v) => v && goto(filterUrl({ state: v }))}>
        <TabsList>
          {#each STATE_FILTERS as s (s)}
            <TabsTrigger value={s}>{STATE_LABEL[s]}</TabsTrigger>
          {/each}
        </TabsList>
      </Tabs>
    </div>
  </div>

  {#if !data.stateApplied && data.filters.state !== 'all' && data.storeStatus !== 'ok'}
    <!-- The state filter needs the ruling store. Saying so beats silently showing everything under
         a tab labelled "Unruled". -->
    <p class="text-dark-2 mb-2 text-sm">Showing every item — rulings cannot be read here.</p>
  {/if}
  {#if data.truncated}
    <p class="text-dark-2 mb-2 text-sm">
      The source returned more groups than this page reads at once; the oldest-moving ones are
      missing.
    </p>
  {/if}

  {#if data.rows.length === 0}
    <p class="text-dark-2">No items match these filters.</p>
  {:else}
    <InboxTable rows={data.rows} {groupHref} />

    <NumberedPager
      page={data.page}
      total={data.total}
      perPage={PAGE_SIZE}
      label="items"
      onPageChange={(p) => goto(urlWith(page.url, { page: p }))}
    />
  {/if}

  <p class="text-dark-2 mt-6 text-xs">
    <strong>new</strong> = founded by the router as a novel issue. <strong>seed</strong> = seeded from
    classifier history; no model call placed its founder, so its probabilities read “—”.
  </p>
{/if}

<script lang="ts">
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import { CSAM_HOLD_STATUS_LABELS, csamHoldFilterParams } from '$lib/csam-holds/hold-filters';
  import { formActionHref } from '$lib/triage/queue';
  import { urlWith } from '$lib/url';
  import CsamHoldDetail from './CsamHoldDetail.svelte';
  import { decisionLabel, entityLabel, holdPreview } from './hold-entity';
  import type { ActionData, PageData } from './$types';

  let {
    data,
    form,
    canDecide,
    canStrike,
    canBan,
  }: {
    data: PageData;
    form: ActionData;
    canDecide: boolean;
    canStrike: boolean;
    canBan: boolean;
  } = $props();

  const parseKey = (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : null);

  // Carries the page's query so a no-JS submit re-renders the same queue.
  const actionHref = (action: string) =>
    formActionHref(action, {
      ...csamHoldFilterParams(data.holdFilters, data.entityType),
      q: data.q || undefined,
      page: data.page > 1 ? data.page : undefined,
      limit: page.url.searchParams.get('limit') ?? undefined,
    });

  const clearFiltersHref = $derived(
    urlWith(page.url, { status: null, entityType: null, sort: null, q: null, page: null, hold: null })
  );
  const filtersActive = $derived(
    data.entityType !== null ||
      data.q !== '' ||
      Object.keys(csamHoldFilterParams(data.holdFilters)).length > 0
  );
  const statusLabel = $derived(
    data.holdFilters.status === 'all'
      ? ''
      : `${CSAM_HOLD_STATUS_LABELS[data.holdFilters.status].toLowerCase()} `
  );
</script>

{#snippet empty()}
  <div class="p-5 text-sm text-dark-0">
    <p class="m-0">
      No {statusLabel}{data.entityType ? `${entityLabel(data.entityType).toLowerCase()} ` : ''}CSAM text
      holds{data.q ? ' match that search' : ''}.
    </p>
    {#if filtersActive}
      <a href={clearFiltersHref} class="mt-2 inline-block {LINK_CLASS}">Clear filters</a>
    {/if}
  </div>
{/snippet}

<TriageShell
  rows={data.items}
  rowKey={(row) => row.id}
  {parseKey}
  selectionParam="hold"
  queueLabel="CSAM text holds queue"
  itemLabel="Hold"
  decisionEnabled={() => []}
  pageNumber={data.page}
  hasMore={data.hasMore}
  offset={data.offset}
  total={data.total}
  {form}
  {empty}
>
  {#snippet listRow(row, state)}
    <TriageRow
      id={state.id}
      href={state.href}
      selected={state.selected}
      title={row.username ?? (row.userId ? `user #${row.userId}` : 'unknown author')}
      meta={`held ${shortAge(row.createdAt)} ago`}
      cover={false}
      verdict={state.verdict}
      error={state.error}
      onselect={state.select}
    >
      {#snippet badges()}
        <Badge variant="secondary">{entityLabel(row.entityType)}</Badge>
        {#if row.status !== 'Pending'}
          <Badge variant="outline">{decisionLabel(row)}</Badge>
        {/if}
        <code class="text-xs text-dark-2">#{row.entityId}</code>
        <span class="block w-full truncate text-xs text-dark-2">{holdPreview(row.text)}</span>
      {/snippet}
    </TriageRow>
  {/snippet}
  {#snippet detail(row, state)}
    <CsamHoldDetail
      {row}
      civitaiUrl={data.civitaiUrl}
      {canDecide}
      {canStrike}
      {canBan}
      verdict={state.verdict}
      error={state.error}
      submit={state.submit}
      {actionHref}
    />
  {/snippet}
</TriageShell>

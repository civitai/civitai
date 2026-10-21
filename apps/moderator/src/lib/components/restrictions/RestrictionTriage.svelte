<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import TriageFilterChips, {
    type ChipGroup,
  } from '$lib/components/triage/TriageFilterChips.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import { originSummary } from '$lib/restrictions/origin';
  import {
    DEFAULT_RESTRICTION_FILTERS,
    RESTRICTION_ORIGIN_LABELS,
    RESTRICTION_ORIGINS,
    RESTRICTION_STATUS_LABELS,
    RESTRICTION_STATUSES,
    resolveRestrictionFilters,
    restrictionFilterParams,
    SORT_LABELS,
    SORT_ORDERS,
    type RestrictionFilters,
  } from '$lib/restriction-filters';
  import { rulingDraft } from '$lib/ruling-draft.svelte';
  import {
    unwiredRulingReason,
    type RestrictionType,
  } from '$lib/restriction-types';
  import type {
    RemixSource,
    RestrictionFacets,
    RestrictionRow,
  } from '$lib/server/user-restriction.service';
  import { formActionHref } from '$lib/triage/queue';
  import { urlWith } from '$lib/url';
  import RestrictionTriageDetail from './RestrictionTriageDetail.svelte';
  import StatusBadge from './StatusBadge.svelte';

  type Verdict = 'Upheld' | 'Overturned';
  type QueueData = {
    items: RestrictionRow[];
    /** The deep-linked restriction when it is not on this page. */
    pinned: RestrictionRow | null;
    selectedMissing: number | null;
    sources: Record<number, RemixSource>;
    sourcesFailed: boolean;
    sourcesNotLoaded: number[];
    facets: RestrictionFacets | undefined;
    totalCount: number;
    page: number;
    hasMore: boolean;
    offset: number;
    type: RestrictionType;
    filters: RestrictionFilters;
    q: string;
    civitaiUrl: string;
    grants: Record<string, boolean | undefined>;
  };

  let {
    data,
    form,
    fallbackType,
  }: {
    data: QueueData;
    form: { error?: string } | null | undefined;
    fallbackType: RestrictionType;
  } = $props();

  // The open restriction, reported by the shell; a chosen verdict belongs to it alone.
  let current = $state<number | null>(null);

  const ruling = rulingDraft<Verdict>(() => current);

  const actionHref = (action: string) =>
    formActionHref(action, {
      type: data.type === fallbackType ? undefined : data.type,
      ...restrictionFilterParams(data.filters),
      q: data.q,
      page: data.page > 1 ? data.page : undefined,
    });

  // A ruling failure is shown on its row and a flag failure in the detail pane. The page-level alert
  // is only for a submit that never ran through enhance, where it is the one place the message appears;
  // with JS it would repeat those messages and outlive the selection they belong to.
  let hydrated = $state(false);
  onMount(() => (hydrated = true));

  const canDecide = (row: RestrictionRow) =>
    row.status === 'Pending' && !unwiredRulingReason(row.type);

  const SELECTION = 'selected';

  const statusGroup = $derived({
    key: 'status',
    label: 'Status',
    values: RESTRICTION_STATUSES,
    labels: RESTRICTION_STATUS_LABELS,
    active: data.filters.status,
    defaultValue: DEFAULT_RESTRICTION_FILTERS.status,
    counts: data.facets?.status,
    resets: ['sort'],
  } satisfies ChipGroup);
  const sortGroup = $derived({
    key: 'sort',
    label: 'Sort',
    values: SORT_ORDERS,
    labels: SORT_LABELS,
    active: data.filters.sort,
    defaultValue: resolveRestrictionFilters({ status: data.filters.status }).sort,
  } satisfies ChipGroup);
  const originGroup = $derived({
    key: 'origin',
    label: 'Origin',
    values: RESTRICTION_ORIGINS,
    labels: RESTRICTION_ORIGIN_LABELS,
    active: data.filters.origin,
    defaultValue: DEFAULT_RESTRICTION_FILTERS.origin,
    counts: data.facets?.origin,
  } satisfies ChipGroup);

  const clearFiltersHref = $derived(
    urlWith(page.url, {
      status: null,
      origin: null,
      sort: null,
      q: null,
      page: null,
      [SELECTION]: null,
    })
  );
  const filtersActive = $derived(
    data.filters.status !== DEFAULT_RESTRICTION_FILTERS.status ||
      data.filters.origin !== DEFAULT_RESTRICTION_FILTERS.origin ||
      !!data.q
  );
</script>

{#snippet notice({ unpicked }: { unpicked: boolean })}
  {#if form?.error && !hydrated}
    <ErrorAlert class="mx-6 mt-3" message={form.error} />
  {/if}
  {#if data.selectedMissing && (unpicked || !hydrated)}
    <ErrorAlert
      class="mx-6 mt-3"
      message="Restriction #{data.selectedMissing} was not found in this queue."
    />
  {/if}
{/snippet}

{#snippet listHeader()}
  <div class="flex flex-col gap-1.5">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <TriageFilterChips groups={[]} sort={statusGroup} selectionParam={SELECTION} />
      <TriageFilterChips groups={[]} sort={sortGroup} selectionParam={SELECTION} />
    </div>
    <TriageFilterChips groups={[originGroup]} selectionParam={SELECTION} />
  </div>
{/snippet}

{#snippet empty()}
  <div class="p-5 text-sm text-dark-0">
    <p class="m-0">
      {data.q ? `Nothing matches "${data.q}".` : 'No restrictions match these filters.'}
    </p>
    {#if filtersActive}
      <a href={clearFiltersHref} class="mt-2 inline-block {LINK_CLASS}">Clear filters</a>
    {/if}
  </div>
{/snippet}

<TriageShell
  flush
  rows={data.items}
  rowKey={(row: RestrictionRow) => row.id}
  parseKey={(raw) => Number(raw) || null}
  selectionParam={SELECTION}
  queueLabel="Restriction queue"
  itemLabel="Restriction"
  decisionEnabled={(row) => [canDecide(row), canDecide(row)]}
  ondecision={(_row, index) => ruling.choose(index === 0 ? 'Upheld' : 'Overturned')}
  pinned={data.pinned}
  bind:current
  pageNumber={data.page}
  hasMore={data.hasMore}
  offset={data.offset}
  total={data.totalCount}
  {notice}
  {listHeader}
  {empty}
>
  {#snippet listRow(row, state)}
    {@const chip = originSummary(row.triggers).chip}
    <TriageRow
      id={state.id}
      href={state.href}
      selected={state.selected}
      title={row.username ?? `User #${row.userId}`}
      meta="{row.status === 'Pending' ? 'waiting' : 'opened'} {shortAge(row.createdAt)}"
      cover={false}
      verdict={state.verdict}
      error={state.error}
      onselect={state.select}
    >
      {#snippet badges()}
        <StatusBadge status={row.status} />
        <span class="text-xs text-dark-2">
          {row.triggers.length} {row.triggers.length === 1 ? 'trigger' : 'triggers'}
        </span>
        {#if chip}<span class="text-xs text-dark-0">{chip}</span>{/if}
      {/snippet}
    </TriageRow>
  {/snippet}
  {#snippet detail(row, state)}
    <RestrictionTriageDetail
      {row}
      civitaiUrl={data.civitaiUrl}
      canBan={!!data.grants['audit.ban.execute']}
      canViewGenerations={!!data.grants['user.generations.view']}
      sources={data.sources}
      sourcesFailed={data.sourcesFailed}
      sourcesNotLoaded={data.sourcesNotLoaded}
      verdict={state.verdict}
      error={state.error}
      submit={state.submit}
      {actionHref}
      choose={ruling.choose}
      bind:draft={() => ruling.current, (d) => (ruling.current = d)}
    />
  {/snippet}
</TriageShell>

<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { emptyRulingDraft, type RulingDraft } from '$lib/components/RulingForm.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import { originSummary } from '$lib/restrictions/origin';
  import {
    unwiredRulingReason,
    type RestrictionType,
    type SortOrder,
  } from '$lib/restriction-types';
  import type {
    RemixSource,
    RestrictionFacets,
    RestrictionRow,
  } from '$lib/server/user-restriction.service';
  import { formActionHref } from '$lib/triage/queue';
  import { urlWith } from '$lib/url';
  import RestrictionFilterBar from './RestrictionFilterBar.svelte';
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
    facets: RestrictionFacets;
    totalCount: number;
    page: number;
    hasMore: boolean;
    offset: number;
    type: RestrictionType;
    status: string;
    origin: string | null;
    sort: SortOrder | null;
    q: string;
    civitaiUrl: string;
    grants: Record<string, boolean | undefined>;
  };

  let {
    data,
    form,
    types,
    fallbackType,
  }: {
    data: QueueData;
    form: { error?: string } | null | undefined;
    types: readonly RestrictionType[];
    fallbackType: RestrictionType;
  } = $props();

  // The open restriction, reported by the shell; a chosen verdict belongs to it alone.
  let current = $state<number | null>(null);

  // A chosen verdict, reason and note belong to one restriction.
  let draft = $state<RulingDraft<Verdict>>(emptyRulingDraft<Verdict>());
  $effect(() => {
    void current;
    draft = emptyRulingDraft<Verdict>();
  });

  const choose = (verdict: Verdict) => {
    draft = { verdict: draft.verdict === verdict ? null : verdict, reason: '', note: '' };
  };

  const actionHref = (action: string) =>
    formActionHref(action, {
      type: data.type === fallbackType ? undefined : data.type,
      status: data.status === 'Pending' ? undefined : data.status,
      origin: data.origin ?? undefined,
      sort: data.sort ?? undefined,
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

  const clearFiltersHref = $derived(
    urlWith(page.url, {
      status: null,
      origin: null,
      sort: null,
      q: null,
      page: null,
      selected: null,
    })
  );
  const filtersActive = $derived(data.status !== 'Pending' || !!data.origin || !!data.q);
</script>

<RestrictionFilterBar
  type={data.type}
  {types}
  {fallbackType}
  status={data.status}
  origin={data.origin}
  sort={data.sort}
  facets={data.facets}
  q={data.q}
/>

{#snippet notice({ unpicked }: { unpicked: boolean })}
  {#if form?.error && !hydrated}
    <ErrorAlert message={form.error} />
  {/if}
  {#if data.selectedMissing && (unpicked || !hydrated)}
    <ErrorAlert message="Restriction #{data.selectedMissing} was not found in this queue." />
  {/if}
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
  rows={data.items}
  rowKey={(row: RestrictionRow) => row.id}
  parseKey={(raw) => Number(raw) || null}
  selectionParam="selected"
  queueLabel="Restriction queue"
  itemLabel="Restriction"
  decisionEnabled={(row) => [canDecide(row), canDecide(row)]}
  ondecision={(_row, index) => choose(index === 0 ? 'Upheld' : 'Overturned')}
  pinned={data.pinned}
  bind:current
  pageNumber={data.page}
  hasMore={data.hasMore}
  offset={data.offset}
  total={data.totalCount}
  {notice}
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
      {choose}
      bind:draft
    />
  {/snippet}
</TriageShell>

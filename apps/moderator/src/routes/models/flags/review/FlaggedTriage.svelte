<script lang="ts">
  import { page } from '$app/state';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
  import { FLAG_REVIEW_RULING_CHOICES, HELD_DETECTION_RULING_CHOICES } from '$lib/ruling-choices';
  import { rulingDraft } from '$lib/ruling-draft.svelte';
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import FlaggedSourceBadge from '$lib/components/minor-flags/FlaggedSourceBadge.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import TriageFilterChips, {
    type ChipGroup,
  } from '$lib/components/triage/TriageFilterChips.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import { flaggedDecisionEnabled } from '$lib/minor-flags/flagged-decision';
  import {
    DEFAULT_FLAGGED_FILTERS,
    FLAGGED_FLAGS,
    FLAGGED_FLAG_LABELS,
    FLAGGED_SORTS,
    FLAGGED_SORT_LABELS,
    FLAGGED_SOURCES,
    FLAGGED_SOURCE_LABELS,
    flaggedFilterParams,
  } from '$lib/minor-flags/flagged-filters';
  import { submitDecisionForm } from '$lib/triage/decision-form';
  import { formActionHref } from '$lib/triage/queue';
  import type { FlaggedQueueData } from '$lib/server/minor-flag-queue';
  import type { FlaggedRow } from '$lib/server/minor-hash.service';
  import { urlWith } from '$lib/url';
  import FlaggedDetail from './FlaggedDetail.svelte';

  type QueueForm = { error?: string; subject?: string } | null;

  let {
    data,
    form,
  }: { data: FlaggedQueueData & { civitaiUrl: string }; form: QueueForm | undefined } = $props();

  type Verdict = ResolutionVerdict<'heldDetection'> | ResolutionVerdict<'flagReview'>;

  let current = $state<string | null>(null);
  const ruling = rulingDraft<Verdict>(() => current);

  // The `data-triage-action` of each hash row's two forms, in key order.
  const HASH_ACTIONS = ['keepFlag', 'liftFlag'] as const;

  const parseKey = (raw: string) => (/^\d+:(minor|poi):(hash|redetected|text-scan)$/.test(raw) ? raw : null);

  // Carries the page's query so a no-JS submit re-renders the same queue.
  const actionHref = (action: string) =>
    formActionHref(action, {
      ...flaggedFilterParams(data.flaggedFilters),
      q: data.q || undefined,
      page: data.page > 1 ? data.page : undefined,
      limit: page.url.searchParams.get('limit') ?? undefined,
    });

  const clearFiltersHref = $derived(
    urlWith(page.url, { source: null, flag: null, sort: null, q: null, page: null, item: null })
  );
  const filtersActive = $derived(Object.keys(flaggedFilterParams(data.flaggedFilters)).length > 0);

  // Source first, with "All" clearing it; the flag chips sit after it and switch themselves off.
  const chipGroups = $derived.by(() => {
    const f = data.flaggedFilters;
    return [
      {
        key: 'source',
        label: 'Source',
        values: FLAGGED_SOURCES,
        labels: FLAGGED_SOURCE_LABELS,
        active: f.source,
        defaultValue: DEFAULT_FLAGGED_FILTERS.source,
      },
      {
        key: 'flag',
        label: 'Flag',
        values: FLAGGED_FLAGS,
        labels: FLAGGED_FLAG_LABELS,
        active: f.flag,
        defaultValue: DEFAULT_FLAGGED_FILTERS.flag,
        toggle: true,
      },
    ] satisfies ChipGroup[];
  });
  const sortGroup = $derived({
    key: 'sort',
    label: 'Sort',
    values: FLAGGED_SORTS,
    labels: FLAGGED_SORT_LABELS,
    active: data.flaggedFilters.sort,
    defaultValue: DEFAULT_FLAGGED_FILTERS.sort,
  } satisfies ChipGroup);

  const ondecision = (row: FlaggedRow, index: number) => {
    if (row.source !== 'hash') {
      const choices: readonly { verdict: Verdict }[] =
        row.source === 'text-scan' ? FLAG_REVIEW_RULING_CHOICES : HELD_DETECTION_RULING_CHOICES;
      const verdict = choices[index]?.verdict;
      if (verdict) ruling.choose(verdict);
      return;
    }
    // A hash flag has no reason to write, so the key submits straight away.
    submitDecisionForm(HASH_ACTIONS, flaggedDecisionEnabled(row), index);
  };
</script>

{#snippet listHeader()}
  <TriageFilterChips groups={chipGroups} sort={sortGroup} selectionParam="item" />
{/snippet}

{#snippet empty()}
  <div class="p-5 text-sm text-dark-0">
    {#if data.q}
      <p class="m-0">Nothing matches "{data.q}".</p>
    {:else if filtersActive}
      <p class="m-0">No flags match these filters.</p>
    {:else}
      <p class="m-0">No automatic flags are waiting on a ruling.</p>
    {/if}
    {#if filtersActive || data.q}
      <a href={clearFiltersHref} class="mt-2 inline-block {LINK_CLASS}">Clear filters</a>
    {/if}
  </div>
{/snippet}

<TriageShell
  flush
  rows={data.items}
  rowKey={(row: FlaggedRow) => row.key}
  {parseKey}
  selectionParam="item"
  queueLabel="Flagged queue"
  itemLabel="Flag"
  decisionEnabled={flaggedDecisionEnabled}
  {ondecision}
  bind:current
  outcomeFor={(result, outcome) =>
    result.type === 'success' && result.data?.resolved === 'closed' ? 'Already flagged' : outcome}
  pageNumber={data.page}
  hasMore={data.hasMore}
  offset={data.offset}
  total={data.total}
  {form}
  {listHeader}
  {empty}
>
  {#snippet listRow(row, state)}
    <TriageRow
      id={state.id}
      href={state.href}
      selected={state.selected}
      title={row.modelName}
      meta={row.flaggedAt ? `flagged ${shortAge(row.flaggedAt)}` : 'flagged'}
      coverUrl={row.coverImages[0]?.url}
      verdict={state.verdict}
      error={state.error}
      onselect={state.select}
    >
      {#snippet badges()}
        <FlaggedSourceBadge {row} />
        <FlagBadge label={row.label} />
        {#if row.hasPendingAppeal}
          <MetaChip tone="amber">also in Appeals</MetaChip>
        {/if}
        {#if row.daysLeft !== null}
          <span class="text-xs text-dark-2 tabular-nums">{row.daysLeft === 0 ? 'window closed' : `${row.daysLeft} d left`}</span>
        {/if}
      {/snippet}
    </TriageRow>
  {/snippet}
  {#snippet detail(row, state)}
    <FlaggedDetail
      {row}
      civitaiUrl={data.civitaiUrl}
      verdict={state.verdict}
      error={state.error}
      submit={state.submit}
      {actionHref}
      bind:draft={() => ruling.current, (d) => (ruling.current = d)}
    />
  {/snippet}
</TriageShell>

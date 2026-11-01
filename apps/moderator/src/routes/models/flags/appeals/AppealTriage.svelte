<script lang="ts">
  import { page } from '$app/state';
  import ModelFlagTabs from '../ModelFlagTabs.svelte';
  import CrossTabChips from '$lib/components/minor-flags/CrossTabChips.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import { sameFileAppealBadge } from '$lib/minor-flags/appeal-row';
  import { rulingDraft } from '$lib/ruling-draft.svelte';
  import TriageFilterChips, {
    type ChipGroup,
  } from '$lib/components/triage/TriageFilterChips.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import {
    APPEAL_FLAGS,
    APPEAL_SORTS,
    DEFAULT_APPEAL_FILTERS,
    FLAG_LABELS,
    SORT_LABELS,
    SOURCE_LABELS,
    appealFilterParams,
    type AppealSource,
  } from '$lib/minor-flags/appeal-filters';
  import { pressDecisionKey } from '$lib/triage/decision-form';
  import { formActionHref } from '$lib/triage/queue';
  import { crossTabChips } from '$lib/minor-flags/cross-tab';
  import { flagInForce, poiInForce } from '$lib/minor-flags/text-scan-verdicts';
  import type { MinorFlagAppealRow } from '$lib/server/minor-hash.service';
  import type { AppealQueueData } from '$lib/server/minor-flag-queue';
  import { urlWith } from '$lib/url';
  import AppealDetail, { type AppealRuling } from './AppealDetail.svelte';
  import AppealTags from './AppealTags.svelte';

  type QueueForm = { error?: string; rescanQueued?: boolean; modelId?: number } | null;

  let {
    data,
    form,
  }: { data: AppealQueueData & { civitaiUrl: string; canViewTrainingData: boolean }; form: QueueForm | undefined } = $props();

  let current = $state<number | null>(null);
  const ruling = rulingDraft<AppealRuling>(() => current);

  // Carries the page's query so a no-JS submit re-renders the same queue.
  const actionHref = (action: string) =>
    formActionHref(action, {
      ...appealFilterParams(data.appealFilters),
      q: data.q,
      page: data.page > 1 ? data.page : undefined,
      limit: page.url.searchParams.get('limit') ?? undefined,
    });

  const clearFiltersHref = $derived(
    urlWith(page.url, { source: null, flag: null, sort: null, page: null, appeal: null })
  );
  const filtersActive = $derived(Object.keys(appealFilterParams(data.appealFilters)).length > 0);
  const total = $derived(data.facets?.source[data.appealFilters.source]);

  // Flag first, with "All" clearing it; the source chips sit after it and switch themselves off.
  const CHIP_SOURCES = ['hash', 'text-scan', 'moderator'] as const satisfies readonly AppealSource[];
  const chipGroups = $derived.by(() => {
    const f = data.appealFilters;
    return [
      {
        key: 'flag',
        label: 'Flag',
        values: APPEAL_FLAGS,
        labels: FLAG_LABELS,
        active: f.flag,
        defaultValue: DEFAULT_APPEAL_FILTERS.flag,
      },
      {
        key: 'source',
        label: 'Source',
        values: CHIP_SOURCES,
        labels: { ...SOURCE_LABELS, hash: 'Hash' },
        active: f.source,
        defaultValue: DEFAULT_APPEAL_FILTERS.source,
        toggle: true,
      },
    ] satisfies ChipGroup[];
  });
  const sortGroup = $derived({
    key: 'sort',
    label: 'Sort',
    values: APPEAL_SORTS,
    labels: SORT_LABELS,
    active: data.appealFilters.sort,
    defaultValue: DEFAULT_APPEAL_FILTERS.sort,
  } satisfies ChipGroup);
</script>

{#snippet notice()}
  {#if form?.rescanQueued}
    <p class="m-0 mx-6 mt-3 rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-sm text-blue-200">
      Model #{form.modelId}: the owner edited the text while the appeal was open, so it will be
      scanned again.
    </p>
  {/if}
{/snippet}

{#snippet listHeader()}
  <div class="flex flex-col gap-2.5">
    <ModelFlagTabs />
    <TriageFilterChips groups={chipGroups} sort={sortGroup} selectionParam="appeal" />
  </div>
{/snippet}

{#snippet empty()}
  <div class="p-5 text-sm text-dark-0">
    {#if data.q}
      <p class="m-0">Nothing matches "{data.q}".</p>
    {:else if filtersActive}
      <p class="m-0">No open appeals match these filters.</p>
    {:else}
      <p class="m-0">No open appeals against a minor or real-person flag.</p>
    {/if}
    {#if filtersActive || data.q}
      <a href={clearFiltersHref} class="mt-2 inline-block {LINK_CLASS}">Clear filters</a>
    {/if}
  </div>
{/snippet}

<TriageShell
  flush
  rows={data.items}
  rowKey={(row: MinorFlagAppealRow) => row.appealId}
  parseKey={(raw) => Number(raw) || null}
  selectionParam="appeal"
  queueLabel="Appeal queue"
  itemLabel="Appeal"
  decisionEnabled={(row) => {
    // Keys 3 and 4 are the two splits, offered only while both flags are in force.
    const split = row.minor && poiInForce(row);
    return [flagInForce(row), true, split, split];
  }}
  ondecision={(_row, index) => pressDecisionKey(index)}
  bind:current
  pageNumber={data.page}
  hasMore={data.hasMore}
  offset={data.offset}
  {total}
  {form}
  {notice}
  {listHeader}
  {empty}
>
  {#snippet listRow(row, state)}
    <TriageRow
      id={state.id}
      href={state.href}
      selected={state.selected}
      title={row.modelName}
      meta="waiting {shortAge(row.appealCreatedAt)}"
      metaClass="text-amber-400"
      coverUrl={row.coverImages[0]?.url}
      verdict={state.verdict}
      error={state.error}
      onselect={state.select}
    >
      {#snippet badges()}
        <AppealTags {row} />
        {@const sameFile = sameFileAppealBadge(row.sameFileAppeals)}
        {#if sameFile}
          <MetaChip tone="amber">{sameFile}</MetaChip>
        {/if}
        <CrossTabChips
          chips={crossTabChips(
            { auto: row.alsoInAutoFlagged, needsReview: row.alsoInNeedsReview },
            row.modelId,
            []
          )}
        />
      {/snippet}
    </TriageRow>
  {/snippet}
  {#snippet detail(row, state)}
    <AppealDetail
      {row}
      civitaiUrl={data.civitaiUrl}
      canViewTrainingData={data.canViewTrainingData}
      verdict={state.verdict}
      error={state.error}
      submit={state.submit}
      {actionHref}
      bind:draft={() => ruling.current, (d) => (ruling.current = d)}
    />
  {/snippet}
</TriageShell>

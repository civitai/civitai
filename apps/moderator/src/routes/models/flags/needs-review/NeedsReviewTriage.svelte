<script lang="ts">
  import { page } from '$app/state';
  import ModelFlagTabs from '../ModelFlagTabs.svelte';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
  import { rulingDraft } from '$lib/ruling-draft.svelte';
  import CrossTabChips from '$lib/components/minor-flags/CrossTabChips.svelte';
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import FlaggedSourceBadge from '$lib/components/minor-flags/FlaggedSourceBadge.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import TriageFilterChips, {
    type ChipGroup,
  } from '$lib/components/triage/TriageFilterChips.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import { crossTabChips } from '$lib/minor-flags/cross-tab';
  import { decisionEnabled, needsReviewDecisions } from '$lib/minor-flags/flagged-decision';
  import {
    FLAGGED_FLAG_LABELS,
    FLAGGED_SORTS,
    FLAGGED_SORT_LABELS,
    FLAG_CHIP_VALUES,
  } from '$lib/minor-flags/flagged-filters';
  import {
    DEFAULT_NEEDS_REVIEW_FILTERS,
    NEEDS_REVIEW_SOURCE_LABELS,
    leadRefs,
    needsReviewFilterParams,
    needsReviewSourceChips,
  } from '$lib/minor-flags/needs-review';
  import { pressDecisionKey } from '$lib/triage/decision-form';
  import { formActionHref } from '$lib/triage/queue';
  import { uniqueBy } from '$lib/triage/unique-by';
  import type { NeedsReviewQueueData } from '$lib/server/minor-flag-queue';
  import type { NeedsReviewRow } from '$lib/server/minor-hash.service';
  import { urlWith } from '$lib/url';
  import NeedsReviewDetail from './NeedsReviewDetail.svelte';

  type QueueForm = { error?: string; subject?: string } | null;

  let {
    data,
    form,
  }: { data: NeedsReviewQueueData & { civitaiUrl: string; canViewTrainingData: boolean }; form: QueueForm | undefined } =
    $props();

  type Verdict = ResolutionVerdict<'heldDetection'> | ResolutionVerdict<'flagReview'>;

  let current = $state<string | null>(null);
  const ruling = rulingDraft<Verdict>(() => current);

  // One row per model. An older link's model:label or model:label:source key still opens that model.
  const parseKey = (raw: string) => /^(\d+)(?::[a-z:-]+)?$/.exec(raw)?.[1] ?? null;

  // Each decision key is on only when every lead allows its part; the first two flag and dismiss every lead.
  const rowDecisionEnabled = (row: NeedsReviewRow) => {
    const leads = leadRefs(row).map((f) => ({ ...f, hasPendingAppeal: row.hasPendingAppeal }));
    return needsReviewDecisions(leads)
      .map((d) => decisionEnabled(leads, d));
  };

  // Carries the page's query so a no-JS submit re-renders the same queue.
  const actionHref = (action: string) =>
    formActionHref(action, {
      ...needsReviewFilterParams(data.needsReviewFilters),
      q: data.q || undefined,
      page: data.page > 1 ? data.page : undefined,
      limit: page.url.searchParams.get('limit') ?? undefined,
    });

  const clearFiltersHref = $derived(
    urlWith(page.url, { source: null, flag: null, sort: null, q: null, page: null, item: null })
  );
  const filtersActive = $derived(
    Object.keys(needsReviewFilterParams(data.needsReviewFilters)).length > 0
  );
  const holdsNothing = $derived(!data.sources.detections && !data.sources.matches);

  // Source chips only when the viewer holds both kinds of lead.
  const chipGroups = $derived.by(() => {
    const f = data.needsReviewFilters;
    return [
      {
        key: 'source',
        label: 'Source',
        values: needsReviewSourceChips(data.sources),
        labels: NEEDS_REVIEW_SOURCE_LABELS,
        active: f.source,
        defaultValue: DEFAULT_NEEDS_REVIEW_FILTERS.source,
        counts: data.chipCounts,
      },
      {
        key: 'flag',
        label: 'Flag',
        values: FLAG_CHIP_VALUES,
        labels: FLAGGED_FLAG_LABELS,
        active: f.flag,
        defaultValue: DEFAULT_NEEDS_REVIEW_FILTERS.flag,
        toggle: true,
      },
    ] satisfies ChipGroup[];
  });
  const sortGroup = $derived({
    key: 'sort',
    label: 'Sort',
    values: FLAGGED_SORTS,
    labels: FLAGGED_SORT_LABELS,
    active: data.needsReviewFilters.sort,
    defaultValue: DEFAULT_NEEDS_REVIEW_FILTERS.sort,
  } satisfies ChipGroup);

  const ondecision = (_row: NeedsReviewRow, index: number) => pressDecisionKey(index);

  // A held detection is timed by when the scan held it; a minor match by its file's upload; a
  // real-person match by when it was matched.
  const rowMeta = (row: NeedsReviewRow) => {
    const verb = row.flags.length ? 'detected' : row.match ? 'uploaded' : 'matched';
    return row.flaggedAt ? `${verb} ${shortAge(row.flaggedAt)}` : verb;
  };
</script>

{#snippet listHeader()}
  <div class="flex flex-col gap-2.5">
    <ModelFlagTabs />
    <TriageFilterChips groups={chipGroups} sort={sortGroup} selectionParam="item" />
  </div>
{/snippet}

{#snippet empty()}
  <div class="p-5 text-sm text-dark-0">
    {#if holdsNothing}
      <p class="m-0">
        You can open this tab but rule neither held detections nor file matches. Ask an admin for
        the permission on /admin.
      </p>
    {:else if data.q}
      <p class="m-0">Nothing matches "{data.q}".</p>
    {:else if filtersActive}
      <p class="m-0">No leads match these filters.</p>
    {:else}
      <p class="m-0">Nothing is waiting for a first decision.</p>
    {/if}
    {#if filtersActive || data.q}
      <a href={clearFiltersHref} class="mt-2 inline-block {LINK_CLASS}">Clear filters</a>
    {/if}
  </div>
{/snippet}

<TriageShell
  flush
  rows={data.items}
  rowKey={(row: NeedsReviewRow) => row.key}
  {parseKey}
  selectionParam="item"
  queueLabel="Needs review queue"
  itemLabel="Lead"
  decisionEnabled={rowDecisionEnabled}
  {ondecision}
  bind:current
  outcomeFor={(result, outcome) =>
    result.type !== 'success'
      ? outcome
      : result.data?.resolved === 'closed'
      ? 'Already flagged'
      : result.data?.resolved === 'keptMinor'
      ? 'Resolved; the model stays minor'
      : outcome}
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
      meta={rowMeta(row)}
      coverUrl={row.coverImages[0]?.url}
      verdict={state.verdict}
      error={state.error}
      onselect={state.select}
    >
      {#snippet badges()}
        {#each uniqueBy(row.flags, (f) => f.label) as flag (flag.label)}
          <FlaggedSourceBadge row={flag} />
          <FlagBadge label={flag.label} />
        {/each}
        {#if row.match}
          <MetaChip tone="blue">hash</MetaChip>
          {#if !row.flags.some((f) => f.label === 'minor')}<FlagBadge label="minor" />{/if}
          <MetaChip truncate>
            shares file with {row.match.minorModelName ?? `model #${row.match.minorModelId}`}
          </MetaChip>
        {/if}
        {#if row.poiMatch}
          {#if !row.match}<MetaChip tone="blue">hash</MetaChip>{/if}
          {#if !row.flags.some((f) => f.label === 'poi')}<FlagBadge label="poi" />{/if}
          {#if row.poiMatch.seedModelId}
            <MetaChip truncate>
              shares file with {row.poiMatch.seedModelName ?? `model #${row.poiMatch.seedModelId}`}
            </MetaChip>
          {/if}
        {/if}
        <CrossTabChips
          chips={crossTabChips(
            { appeals: row.hasPendingAppeal, auto: row.alsoInAutoFlagged },
            row.modelId,
            []
          )}
        />
      {/snippet}
    </TriageRow>
  {/snippet}
  {#snippet detail(row, state)}
    <NeedsReviewDetail
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

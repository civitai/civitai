<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { IconArrowRight, IconPhoto, IconZoomCancel } from '@tabler/icons-svelte';
  import { ratingReviewEntityLabels, ratingReviewLevelLabel } from '@civitai/shared/rating-review';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import TriageFilterChips, {
    type ChipGroup,
  } from '$lib/components/triage/TriageFilterChips.svelte';
  import TriagePageHeader from '$lib/components/triage/TriagePageHeader.svelte';
  import TriageParamTabs from '$lib/components/triage/TriageParamTabs.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import {
    ASK_FILTERS,
    ASK_LABELS,
    DEFAULT_DISPUTE_TAB,
    defaultDisputeSort,
    DISPUTE_SORT_LABELS,
    DISPUTE_SORTS,
    DISPUTE_TAB_LABELS,
    DISPUTE_TABS,
    disputeTitle,
    SCAN_LABELS,
  } from '$lib/rating-dispute';
  import { ratingReviewStatusFilters, type RatingReviewStatusFilter } from '$lib/rating-review';
  import type { RatingDisputeRow } from '$lib/server/rating-dispute-queue';
  import { formActionHref } from '$lib/triage/queue';
  import { urlWith } from '$lib/url';
  import LevelChip from './LevelChip.svelte';
  import RatingDisputeDetail from './RatingDisputeDetail.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const SELECTION = 'selected';
  const STATUS_VALUES = ratingReviewStatusFilters.map((s) => s.value);
  const STATUS_LABELS = Object.fromEntries(
    ratingReviewStatusFilters.map((s) => [s.value, s.label])
  ) as Record<RatingReviewStatusFilter, string>;

  // The open dispute, reported by the shell; a level picked for confirmation belongs to it alone.
  let current = $state<number | null>(null);
  let chosen = $state<number | null>(null);
  $effect(() => {
    void current;
    chosen = null;
  });

  const f = $derived(data.filters);

  const actionHref = (action: string) =>
    formActionHref(action, {
      tab: f.tab === DEFAULT_DISPUTE_TAB ? undefined : f.tab,
      status: f.status === 'Pending' ? undefined : f.status,
      ask: f.ask,
      scan: f.scan,
      sort: f.sort === defaultDisputeSort(f.status) ? undefined : f.sort,
      q: data.q,
      page: data.page > 1 ? data.page : undefined,
    });

  // The shell shows a refusal on its row; a deep link to a missing dispute is announced here until
  // the moderator picks a row.
  let hydrated = $state(false);
  onMount(() => (hydrated = true));

  const statusGroup = $derived({
    key: 'status',
    label: 'Status',
    values: STATUS_VALUES,
    labels: STATUS_LABELS,
    active: f.status,
    defaultValue: 'Pending',
    resets: ['sort'],
    pill: true,
    compact: true,
  } satisfies ChipGroup);
  const sortGroup = $derived({
    key: 'sort',
    label: 'Sort',
    values: DISPUTE_SORTS,
    labels: DISPUTE_SORT_LABELS,
    active: f.sort,
    defaultValue: defaultDisputeSort(f.status),
  } satisfies ChipGroup);
  const chipGroups = $derived([
    {
      key: 'ask',
      label: 'Ask',
      values: ASK_FILTERS,
      labels: ASK_LABELS,
      active: f.ask ?? 'all',
      defaultValue: 'all',
      counts: data.facets?.chips,
      compact: true,
    },
    {
      key: 'scan',
      label: 'Scan',
      values: ['all', 'raised'],
      labels: SCAN_LABELS,
      active: f.scan ?? 'all',
      defaultValue: 'all',
      toggle: true,
      counts: data.facets ? { raised: data.facets.chips.raised } : undefined,
      compact: true,
    },
  ] satisfies ChipGroup[]);

  const clearSearchHref = $derived(urlWith(page.url, { q: null, page: null, [SELECTION]: null }));
  const tabs = DISPUTE_TABS.map((value) => ({ value, ...DISPUTE_TAB_LABELS[value] }));

  const waitText = (row: RatingDisputeRow) => {
    const pending = row.status === 'Pending';
    const at = pending ? row.createdAt : (row.resolvedAt ?? row.createdAt);
    return `${pending ? 'waiting' : 'ruled'} ${at ? shortAge(at) : ''}`.trim();
  };
  const emptyTitle = $derived(
    `No ${STATUS_LABELS[f.status].toLowerCase()} ${DISPUTE_TAB_LABELS[f.tab].noun} disputes${data.q ? ` match "${data.q}"` : ''}`
  );
</script>

{#snippet notice({ unpicked }: { unpicked: boolean })}
  {#if data.selectedMissing && (unpicked || !hydrated)}
    <ErrorAlert
      class="mx-6 mt-3"
      message="Dispute #{data.selectedMissing} was not found in this queue."
    />
  {/if}
{/snippet}

{#snippet listHeader()}
  <div class="flex flex-col gap-1.5">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <TriageFilterChips groups={[]} sort={statusGroup} selectionParam={SELECTION} />
      <TriageFilterChips groups={[]} sort={sortGroup} selectionParam={SELECTION} />
    </div>
    <TriageFilterChips groups={chipGroups} selectionParam={SELECTION} />
  </div>
{/snippet}

<!-- The shell renders this in the list and again in the detail pane when nothing matches; the
     `in-[...]` variants pick the half that belongs to the pane it landed in. -->
{#snippet empty()}
  <div
    class="flex h-full flex-col items-center justify-center gap-1 p-5 text-center text-sm text-dark-0 in-[section]:hidden"
  >
    <IconZoomCancel class="mb-1.5 size-5 text-dark-2" aria-hidden="true" />
    <p class="m-0 font-medium text-white">{emptyTitle}</p>
    <p class="m-0 text-xs text-dark-2">Search matches an owner username or an ID.</p>
    {#if data.q}
      <a href={clearSearchHref} class="text-xs {LINK_CLASS}">Clear search</a>
    {/if}
  </div>
  <p class="m-0 hidden text-sm text-dark-2 in-[section]:block">Select a dispute to review it.</p>
{/snippet}

<div class="flex flex-col lg:h-svh">
  <TriagePageHeader
    title="Rating disputes"
    subtitle="Owners asking for a different rating. Apply the rating the content earns; the owner sees your note."
    placeholder="Owner or ID"
    searchLabel="Search rating disputes"
  />
  <TriageParamTabs
    {tabs}
    current={f.tab}
    param="tab"
    defaultValue={DEFAULT_DISPUTE_TAB}
    label="Dispute type"
    selectionParam={SELECTION}
    counts={data.facets?.tabs}
  />
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <TriageShell
      flush
      rows={data.items}
      rowKey={(row: RatingDisputeRow) => row.id}
      parseKey={(raw) => Number(raw) || null}
      selectionParam={SELECTION}
      queueLabel="Dispute queue"
      itemLabel="Dispute"
      decisionEnabled={(row) => row.levelOptions.map(() => row.status === 'Pending')}
      ondecision={(row, index) => (chosen = row.levelOptions[index] ?? chosen)}
      pinned={data.pinned}
      bind:current
      pageNumber={data.page}
      hasMore={data.hasMore}
      offset={data.offset}
      total={data.totalCount}
      {form}
      {notice}
      {listHeader}
      {empty}
    >
      {#snippet listRow(row, state)}
        {@const pending = row.status === 'Pending'}
        {@const scan = row.scan}
        <TriageRow
          id={state.id}
          href={state.href}
          selected={state.selected}
          title={disputeTitle(row.entityType, row.entityId, row.entity)}
          meta={waitText(row)}
          metaClass={pending ? 'text-amber-300' : 'text-dark-2'}
          coverUrl={row.entity?.coverUrl ?? undefined}
          coverType={row.entity?.coverType}
          verdict={state.verdict}
          error={state.error}
          onselect={state.select}
        >
          {#snippet coverIcon()}<IconPhoto aria-hidden="true" />{/snippet}
          {#snippet badges()}
            {#if f.tab === 'other'}
              <span class="rounded border border-dark-4 px-1.5 py-px text-[11px] text-dark-1">
                {ratingReviewEntityLabels[row.entityType]}
              </span>
            {/if}
            {#if !row.entity}<span class="text-[11px] text-dark-2 italic">Deleted</span>{/if}
            <LevelChip label={ratingReviewLevelLabel(row.entityType, row.currentLevel)} />
            <IconArrowRight class="size-3 text-dark-2" aria-hidden="true" />
            <LevelChip
              tone="ask"
              label={ratingReviewLevelLabel(row.entityType, row.suggestedLevel)}
            />
            <span class="basis-full truncate text-xs text-dark-2">
              {row.user.username ?? `User #${row.user.id}`}
              {#if scan}· scan {ratingReviewLevelLabel(row.entityType, scan.level)}{/if}
              · {row.userComment ? 'commented' : 'no comment'}
            </span>
          {/snippet}
        </TriageRow>
      {/snippet}
      {#snippet detail(row, state)}
        <RatingDisputeDetail
          {row}
          civitaiUrl={data.civitaiUrl}
          verdict={state.verdict}
          error={state.error}
          submit={state.submit}
          {actionHref}
          bind:chosen
        />
      {/snippet}
    </TriageShell>
  </div>
</div>

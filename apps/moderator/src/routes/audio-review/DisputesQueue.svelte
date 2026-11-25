<script lang="ts">
  import type { Snippet } from 'svelte';
  import { IconArrowRight, IconMusic } from '@tabler/icons-svelte';
  import TriageFilterChips, {
    type ChipGroup,
  } from '$lib/components/triage/TriageFilterChips.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import {
    disputeKeysEnabled,
    disputeRowTitle,
    DISPUTE_FILTERS,
    DISPUTE_STATUS_LABELS,
    DISPUTE_STATUSES,
    songRatingLabel,
    SONG_RATING_LEVELS,
    type DisputeFilter,
    type DisputeSort,
    type DisputeStatus,
    type SongDisputeRow,
  } from '$lib/audio-review';
  import { shortAge, waitingMeta } from '$lib/format';
  import { ASK_LABELS, recordedVerdict } from '$lib/rating-dispute';
  import { formActionHref } from '$lib/triage/queue';
  import LevelChip from '../ratings/LevelChip.svelte';
  import DisputeSongDetail from './DisputeSongDetail.svelte';
  import OwnerFilterChip from './OwnerFilterChip.svelte';
  import QueueEmpty from './QueueEmpty.svelte';
  import { oldestNewestSort } from './queue';

  let {
    disputes,
    filters,
    q,
    page,
    canAct,
    civitaiUrl,
    form,
    tabsBar,
  }: {
    disputes: {
      items: SongDisputeRow[];
      hasMore: boolean;
      total: number;
      facets: Record<DisputeFilter, number>;
      offset: number;
    };
    filters: { sort: DisputeSort; ask: DisputeFilter; status: DisputeStatus; owner: number | null };
    q: string;
    page: number;
    canAct: boolean;
    civitaiUrl: string;
    /** The page's action result; TriageShell shows a refusal it names by `key`. */
    form: { error?: string; subject?: string; key?: string | number } | null | undefined;
    tabsBar: Snippet;
  } = $props();

  const SELECTION = 'selected';

  // A picked level is only valid for the dispute it was picked on, as on /ratings.
  let current = $state<number | null>(null);
  let pick = $state<{ id: number; level: number } | null>(null);
  const chosen = $derived(pick !== null && pick.id === current ? pick.level : null);
  const setChosen = (level: number | null) =>
    (pick = level === null || current === null ? null : { id: current, level });

  const actionHref = (action: string) =>
    formActionHref(action, {
      tab: 'disputes',
      sort: filters.sort === 'oldest' ? undefined : filters.sort,
      ask: filters.ask === 'all' ? undefined : filters.ask,
      status: filters.status === 'pending' ? undefined : filters.status,
      owner: filters.owner ?? undefined,
      q,
      page: page > 1 ? page : undefined,
    });

  const sortGroup = $derived(oldestNewestSort(filters.sort));
  const statusGroup = $derived({
    key: 'status',
    label: 'Status',
    values: DISPUTE_STATUSES,
    labels: DISPUTE_STATUS_LABELS,
    active: filters.status,
    defaultValue: 'pending',
    pill: true,
  } satisfies ChipGroup);
  const RULING_CHIP: Record<string, { label: string; class: string }> = {
    Actioned: { label: 'Approved', class: 'bg-green-500/15 text-green-300' },
    Unactioned: { label: 'Rejected', class: 'bg-dark-5 text-dark-0' },
  };
  const askGroup = $derived({
    key: 'ask',
    label: 'Ask',
    values: DISPUTE_FILTERS,
    labels: ASK_LABELS,
    active: filters.ask,
    defaultValue: 'all',
    counts: disputes.facets,
    compact: true,
  } satisfies ChipGroup);

  const decisionsFor = (row: SongDisputeRow) => disputeKeysEnabled(row, canAct);
</script>

{#snippet listHeader()}
  <div class="flex flex-col gap-2.5">
    {@render tabsBar()}
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <TriageFilterChips status={statusGroup} sort={sortGroup} selectionParam={SELECTION} />
    </div>
    <TriageFilterChips groups={[askGroup]} selectionParam={SELECTION} />
    {#if filters.owner != null}
      <OwnerFilterChip
        ownerId={filters.owner}
        username={disputes.items.find((r) => r.owner)?.owner?.username ?? null}
      />
    {/if}
  </div>
{/snippet}

{#snippet empty()}
  <QueueEmpty
    nothing={filters.status === 'pending'
      ? 'No pending rating disputes'
      : filters.status === 'resolved'
        ? 'No resolved rating disputes'
        : 'No rating disputes'}
    {q}
    pick="Select a dispute to review it."
  />
{/snippet}

<TriageShell
  flush
  rows={disputes.items}
  rowKey={(row: SongDisputeRow) => row.id}
  parseKey={(raw) => Number(raw) || null}
  selectionParam={SELECTION}
  queueLabel="Rating disputes"
  itemLabel="Dispute"
  decisionEnabled={decisionsFor}
  ondecision={(row, index) => {
    const level = SONG_RATING_LEVELS[index];
    if (level !== undefined) pick = { id: row.id, level };
  }}
  outcomeFor={(result, outcome) =>
    result.type === 'success' ? recordedVerdict(result.data?.status, outcome) : outcome}
  bind:current
  pageNumber={page}
  hasMore={disputes.hasMore}
  offset={disputes.offset}
  total={disputes.total}
  {form}
  {listHeader}
  {empty}
>
  {#snippet listRow(row, state)}
    <TriageRow
      id={state.id}
      href={state.href}
      selected={state.selected}
      title={disputeRowTitle(row)}
      {...row.status === 'Pending' || !row.ruling?.resolvedAt
        ? waitingMeta(row.waitingSince)
        : { meta: `ruled ${shortAge(row.ruling.resolvedAt)}`, metaClass: 'text-dark-2' }}
      coverUrl={row.coverUrl ?? undefined}
      verdict={state.verdict}
      error={state.error}
      onselect={state.select}
    >
      {#snippet coverIcon()}<IconMusic aria-hidden="true" />{/snippet}
      {#snippet badges()}
        {#if row.currentLevel != null && row.suggestedLevel != null}
          <LevelChip label={songRatingLabel(row.currentLevel)} />
          <IconArrowRight class="size-3 text-dark-2" aria-hidden="true" />
          <LevelChip tone="ask" label={songRatingLabel(row.suggestedLevel)} />
        {/if}
        {#if RULING_CHIP[row.status]}
          <span class="rounded px-1.5 py-px text-[11px] font-medium {RULING_CHIP[row.status].class}">
            {RULING_CHIP[row.status].label}
          </span>
        {/if}
        {#if (row.disputes ?? 0) > 1}
          <span class="rounded bg-amber-500/15 px-1.5 py-px text-[11px] font-medium text-amber-300">
            Repeat ×{row.disputes}
          </span>
        {/if}
        {#if row.state === 'unreviewed'}
          <span class="text-[11px] text-dark-2 italic">Scans not finished</span>
        {:else if row.state === 'gone'}
          <span class="text-[11px] text-dark-2 italic">Can't be rated</span>
        {/if}
        {#if row.owner}
          <span class="basis-full truncate text-xs text-dark-2">
            {row.owner.username ?? `User #${row.owner.id}`} · {row.message
              ? 'commented'
              : 'no comment'}
          </span>
        {/if}
      {/snippet}
    </TriageRow>
  {/snippet}
  {#snippet detail(row, state)}
    <DisputeSongDetail
      {row}
      {civitaiUrl}
      {canAct}
      verdict={state.verdict}
      error={state.error}
      submit={state.submit}
      {actionHref}
      bind:chosen={() => chosen, setChosen}
    />
  {/snippet}
</TriageShell>

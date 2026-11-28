<script lang="ts">
  import { IconMusic, IconPlayerPlay } from '@tabler/icons-svelte';
  import { formatPlaybackTime } from '@civitai/shared';
  import { SvelteMap } from 'svelte/reactivity';
  import TriageFilterChips, {
    type ChipGroup,
  } from '$lib/components/triage/TriageFilterChips.svelte';
  import TriagePageHeader from '$lib/components/triage/TriagePageHeader.svelte';
  import TriageParamTabs from '$lib/components/triage/TriageParamTabs.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import {
    AUDIO_TAB_LABELS,
    AUDIO_TABS,
    DEFAULT_AUDIO_TAB,
    REPORTED_DECISIONS,
    REPORTED_FILTER_LABELS,
    REPORTED_FILTERS,
    REPORTED_SORT_LABELS,
    REPORTED_SORTS,
    ratingKeysEnabled,
    reportedDecisionsEnabled,
    reportedOutcome,
    songRemovedTitle,
    songReportReasons,
    SONG_RATING_LEVELS,
    songTitle,
    type ReportedSongRow,
  } from '$lib/audio-review';
  import { plural, waitingMeta } from '$lib/format';
  import { removedCovers } from '$lib/music/removed-covers';
  import { submitDecisionForm } from '$lib/triage/decision-form';
  import { formActionHref } from '$lib/triage/queue';
  import AppealsQueue from './AppealsQueue.svelte';
  import DisputesQueue from './DisputesQueue.svelte';
  import HeldQueue from './HeldQueue.svelte';
  import QueueEmpty from './QueueEmpty.svelte';
  import ReportedSongDetail from './ReportedSongDetail.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const SELECTION = 'selected';
  const reported = $derived(data.tab === 'reported' ? data.reported : null);
  const f = $derived(data.tab === 'reported' ? data.filters : { sort: 'oldest', filter: 'all' });

  let current = $state<number | null>(null);
  let ratingOpen = $state(false);
  const closeRating = () => (ratingOpen = false);
  const select = (key: number | null) => {
    if (key !== current) ratingOpen = false;
    current = key;
  };
  // A rating leaves the song in the queue without a reload, so the level given here is kept.
  const rated = new SvelteMap<number, number>();
  const levelOf = (row: ReportedSongRow) => rated.get(row.id) ?? row.nsfwLevel;
  // A cover removed on this page, without reading the queue again.
  const live = (row: ReportedSongRow): ReportedSongRow =>
    row.removableCoverId != null && removedCovers.has(row.removableCoverId)
      ? { ...row, removableCoverId: null, coverUrl: null }
      : row;

  const actionHref = (action: string) =>
    formActionHref(action, {
      sort: f.sort === 'oldest' ? undefined : f.sort,
      has: f.filter === 'all' ? undefined : f.filter,
      q: data.q,
      page: data.page > 1 ? data.page : undefined,
    });

  const tabs = AUDIO_TABS.map((value) => ({ value, label: AUDIO_TAB_LABELS[value] }));

  const sortGroup = $derived({
    key: 'sort',
    label: 'Sort',
    values: REPORTED_SORTS,
    labels: REPORTED_SORT_LABELS,
    active: f.sort,
    defaultValue: 'oldest',
    pill: true,
  } satisfies ChipGroup);
  const filterGroup = $derived({
    key: 'has',
    label: 'Show',
    values: REPORTED_FILTERS,
    labels: REPORTED_FILTER_LABELS,
    active: f.filter,
    defaultValue: 'all',
    counts: reported?.facets,
    compact: true,
  } satisfies ChipGroup);

  const firstTime = (row: ReportedSongRow) => row.reports.find((r) => r.timeSec != null)?.timeSec;

  const picking = (row: ReportedSongRow) => ratingOpen && row.id === current;
  const decisionsFor = (row: ReportedSongRow) => {
    const enabled = reportedDecisionsEnabled(live(row), data.canAct);
    return picking(row) ? ratingKeysEnabled(levelOf(row), enabled[3]) : enabled;
  };

  function decide(row: ReportedSongRow, index: number) {
    if (picking(row)) {
      const level = SONG_RATING_LEVELS[index];
      closeRating();
      document
        .querySelector<HTMLButtonElement>(
          `[data-triage-actions] form[data-rating-form] button[value="${level}"]`
        )
        ?.click();
      return;
    }
    if (REPORTED_DECISIONS[index] === 'rate') {
      ratingOpen = true;
      return;
    }
    submitDecisionForm(REPORTED_DECISIONS, reportedDecisionsEnabled(live(row), data.canAct), index);
  }

  function onkeydown(e: KeyboardEvent) {
    if (ratingOpen && e.key === 'Escape') {
      e.preventDefault();
      closeRating();
    }
  }
</script>

<svelte:window {onkeydown} />

{#snippet tabsBar()}
  <TriageParamTabs
    {tabs}
    current={data.tab}
    param="tab"
    defaultValue={DEFAULT_AUDIO_TAB}
    label="Audio review"
    selectionParam={SELECTION}
    counts={data.counts}
  />
{/snippet}

{#snippet listHeader()}
  <div class="flex flex-col gap-2.5">
    {@render tabsBar()}
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <TriageFilterChips sort={sortGroup} selectionParam={SELECTION} />
    </div>
    <TriageFilterChips groups={[filterGroup]} selectionParam={SELECTION} />
  </div>
{/snippet}

{#snippet empty()}
  <QueueEmpty nothing="No reported songs" q={data.q} pick="Select a song to review it." />
{/snippet}

<div class="flex flex-col lg:h-svh">
  <TriagePageHeader
    title="Audio review"
    subtitle="Songs and their covers: reports, appeals, holds and rating disputes. Decide on the song, its cover and its rating together."
    placeholder="Song, owner or ID"
    searchLabel={data.tab === 'appeals'
      ? 'Search appealed songs and covers'
      : data.tab === 'held'
      ? 'Search held songs'
      : data.tab === 'disputes'
      ? 'Search disputed songs'
      : 'Search reported songs'}
  />
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    {#if data.tab === 'disputes'}
      <DisputesQueue
        disputes={data.disputes}
        filters={data.disputes.filters}
        q={data.q}
        page={data.page}
        canAct={data.canAct}
        civitaiUrl={data.civitaiUrl}
        {form}
        {tabsBar}
      />
    {:else if data.tab === 'held'}
      <HeldQueue
        held={data.held}
        filters={data.held.filters}
        q={data.q}
        page={data.page}
        canAct={data.canAct}
        canOpenHolds={data.canOpenHolds}
        civitaiUrl={data.civitaiUrl}
        {form}
        {tabsBar}
      />
    {:else if data.tab === 'appeals'}
      <AppealsQueue
        appeals={data.appeals}
        filters={data.appeals.filters}
        q={data.q}
        page={data.page}
        canAct={data.canAct}
        civitaiUrl={data.civitaiUrl}
        {form}
        {tabsBar}
      />
    {:else if reported}
      <TriageShell
        flush
        rows={reported.items}
        rowKey={(row: ReportedSongRow) => row.id}
        parseKey={(raw) => Number(raw) || null}
        selectionParam={SELECTION}
        queueLabel="Reported songs"
        itemLabel="Song"
        decisionEnabled={decisionsFor}
        decisionActions={REPORTED_DECISIONS}
        ondecision={decide}
        ondecisionrefused={(row) => {
          // The digit of the level the song already has: nothing to change, so the picker closes.
          if (picking(row)) closeRating();
        }}
        outcomeFor={reportedOutcome}
        pinned={reported.pinned}
        bind:current={() => current, select}
        pageNumber={data.page}
        hasMore={reported.hasMore}
        offset={reported.offset}
        total={reported.total}
        {form}
        {listHeader}
        {empty}
      >
        {#snippet listRow(row, state)}
          {@const reasons = songReportReasons(row.reports)}
          <TriageRow
            id={state.id}
            href={state.href}
            selected={state.selected}
            title={songTitle(row)}
            {...waitingMeta(row.waitingSince)}
            coverUrl={live(row).coverUrl ?? undefined}
            verdict={state.verdict}
            error={state.error}
            onselect={state.select}
          >
            {#snippet coverIcon()}<IconMusic aria-hidden="true" />{/snippet}
            {#snippet badges()}
              {#if reasons[0]}
                <span class="rounded bg-red-500/15 px-1.5 py-px text-[11px] font-medium text-red-300">
                  {reasons[0]}
                </span>
              {/if}
              <span class="rounded bg-dark-5 px-1.5 py-px text-[11px] font-medium text-dark-0">
                {plural(row.reportCount, 'report')}
              </span>
              {#if firstTime(row) != null}
                {@const at = firstTime(row) ?? 0}
                <span
                  class="inline-flex items-center gap-0.5 rounded bg-blue-500/15 px-1.5 py-px text-[11px] font-medium text-blue-300"
                >
                  <IconPlayerPlay size={11} aria-hidden="true" />{formatPlaybackTime(at)}
                </span>
              {/if}
              {#if row.removed}
                <span class="text-[11px] text-dark-2 italic" title={songRemovedTitle(row)}>Removed</span>
              {/if}
              {#if row.owner}
                <span class="ml-auto truncate text-xs text-dark-2">
                  {row.owner.username ?? `User #${row.owner.id}`}
                </span>
              {/if}
            {/snippet}
          </TriageRow>
        {/snippet}
        {#snippet detail(row, state)}
          <ReportedSongDetail
            row={live(row)}
            civitaiUrl={data.civitaiUrl}
            canAct={data.canAct}
            verdict={state.verdict}
            error={state.error}
            submit={state.submit}
            {actionHref}
            level={levelOf(row)}
            ratingOpen={picking(row)}
            onrate={() => (ratingOpen = true)}
            onrated={(level) => {
              closeRating();
              if (level === null) rated.delete(row.id);
              else rated.set(row.id, level);
            }}
          />
        {/snippet}
      </TriageShell>
    {/if}
  </div>
</div>

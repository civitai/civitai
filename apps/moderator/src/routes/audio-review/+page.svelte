<script lang="ts">
  import { IconMusic, IconPlayerPlay, IconZoomCancel } from '@tabler/icons-svelte';
  import { formatPlaybackTime } from '@civitai/shared';
  import { SvelteMap } from 'svelte/reactivity';
  import { page } from '$app/state';
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
    LIVE_AUDIO_TABS,
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
    type ReportedSongRow,
  } from '$lib/audio-review';
  import { LINK_CLASS, plural, shortAge } from '$lib/format';
  import { removedCovers } from '$lib/music/removed-covers';
  import { submitDecisionForm } from '$lib/triage/decision-form';
  import { formActionHref } from '$lib/triage/queue';
  import { urlWith } from '$lib/url';
  import AppealsQueue from './AppealsQueue.svelte';
  import ReportedSongDetail from './ReportedSongDetail.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const SELECTION = 'selected';
  // The Reported tab's data; the Appeals tab has its own queue (`AppealsQueue`).
  const reported = $derived(data.tab === 'reported' ? data.reported : null);
  const f = $derived(data.tab === 'reported' ? data.filters : { sort: 'oldest', filter: 'all' });

  // Key 4 opens the rating row for the open song; the next digit picks its level. Moving to another
  // song closes it.
  let current = $state<number | null>(null);
  let ratingOpen = $state(false);
  const closeRating = () => (ratingOpen = false);
  const select = (key: number | null) => {
    if (key !== current) ratingOpen = false;
    current = key;
  };
  // A rating is a correction, not a decision: the song stays in the queue and the page does not
  // reload, so the level each song was given here is kept for when the moderator comes back to it.
  const rated = new SvelteMap<number, number>();
  const levelOf = (row: ReportedSongRow) => rated.get(row.id) ?? row.nsfwLevel;
  // A cover removed on this page is no longer there to remove: key 3 goes off, and the thumbnail
  // drops to the placeholder, without reading the queue again.
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

  const tabs = AUDIO_TABS.map((value) => ({
    value,
    label: AUDIO_TAB_LABELS[value],
    disabled: !LIVE_AUDIO_TABS.includes(value),
    hint: LIVE_AUDIO_TABS.includes(value) ? undefined : 'Coming soon on this page',
  }));

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

  const clearSearchHref = $derived(urlWith(page.url, { q: null, page: null, [SELECTION]: null }));
  // Amber once a song has waited a day, as the other triage queues mark someone waiting.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const waitedLong = (row: ReportedSongRow) =>
    Date.now() - new Date(row.waitingSince).getTime() >= DAY_MS;
  const firstTime = (row: ReportedSongRow) => row.reports.find((r) => r.timeSec != null)?.timeSec;
  const rowTitle = (row: ReportedSongRow) =>
    row.withheld ? `Withheld song #${row.id}` : row.title || `Untitled song #${row.id}`;

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
  <div
    class="flex h-full flex-col items-center justify-center gap-1 p-5 text-center text-sm text-dark-0 in-[section]:hidden"
  >
    <IconZoomCancel class="mb-1.5 size-5 text-dark-2" aria-hidden="true" />
    <p class="m-0 font-medium text-white">
      No reported songs{data.q ? ` match "${data.q}"` : ''}
    </p>
    <p class="m-0 text-xs text-dark-2">Search matches a song title, an owner username or an ID.</p>
    {#if data.q}
      <a href={clearSearchHref} class="text-xs {LINK_CLASS}">Clear search</a>
    {/if}
  </div>
  <p class="m-0 hidden text-sm text-dark-2 in-[section]:block">Select a song to review it.</p>
{/snippet}

<div class="flex flex-col lg:h-svh">
  <TriagePageHeader
    title="Audio review"
    subtitle="Songs and their covers: reports, appeals and holds. Decide on the song, its cover and its rating together."
    placeholder="Song, owner or ID"
    searchLabel={data.tab === 'appeals' ? 'Search appealed songs and covers' : 'Search reported songs'}
  />
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    {#if data.tab === 'appeals'}
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
            title={rowTitle(row)}
            meta={waitedLong(row) ? `waiting ${shortAge(row.waitingSince)}` : shortAge(row.waitingSince)}
            metaClass={waitedLong(row) ? 'text-amber-300' : 'text-dark-2'}
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

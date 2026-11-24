<script lang="ts">
  import type { Snippet } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { IconLock, IconMusic, IconZoomCancel } from '@tabler/icons-svelte';
  import { page as pageState } from '$app/state';
  import TriageFilterChips, {
    type ChipGroup,
  } from '$lib/components/triage/TriageFilterChips.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import {
    HELD_FILTER_LABELS,
    HELD_FILTERS,
    heldDecisions,
    heldDecisionsEnabled,
    heldRowTitle,
    ratingKeysEnabled,
    reportedOutcome,
    SONG_RATING_LEVELS,
    type HeldFilter,
    type HeldSongRow,
    type HeldSort,
  } from '$lib/audio-review';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import { removedCovers } from '$lib/music/removed-covers';
  import { pressDecisionKey } from '$lib/triage/decision-form';
  import { formActionHref } from '$lib/triage/queue';
  import { urlWith } from '$lib/url';
  import HeldSongDetail from './HeldSongDetail.svelte';

  // Audio review's Held tab: songs whose lyrics are under a CSAM text hold (decided in CSAM holds),
  // songs whose own cover is flagged for review, and songs flagged themselves
  // (docs/features/music.md "Moderating songs").
  let {
    held,
    filters,
    q,
    page,
    canAct,
    canOpenHolds,
    civitaiUrl,
    form,
    tabsBar,
  }: {
    held: {
      items: HeldSongRow[];
      hasMore: boolean;
      total: number;
      facets: Record<HeldFilter, number>;
      offset: number;
    };
    filters: { sort: HeldSort; kind: HeldFilter };
    q: string;
    page: number;
    canAct: boolean;
    canOpenHolds: boolean;
    civitaiUrl: string;
    /** The page's action result; TriageShell shows a refusal it names by `key`. */
    form: { error?: string; subject?: string; key?: string | number } | null | undefined;
    tabsBar: Snippet;
  } = $props();

  const SELECTION = 'selected';

  // Set rating opens the rating row for the open song; the next digit picks its level. Moving to
  // another song closes it.
  let current = $state<number | null>(null);
  let ratingOpen = $state(false);
  const closeRating = () => (ratingOpen = false);
  const select = (key: number | null) => {
    if (key !== current) ratingOpen = false;
    current = key;
  };
  // A rating is a correction: the song stays in the queue, so the level given here is kept.
  const rated = new SvelteMap<number, number>();
  const levelOf = (row: HeldSongRow) => rated.get(row.id) ?? row.nsfwLevel;
  // A cover removed on this page is no longer there to approve or remove.
  const live = (row: HeldSongRow): HeldSongRow =>
    row.removableCoverId != null && removedCovers.has(row.removableCoverId)
      ? { ...row, removableCoverId: null, coverUrl: null, cover: null }
      : row;

  const actionHref = (action: string) =>
    formActionHref(action, {
      tab: 'held',
      sort: filters.sort === 'oldest' ? undefined : filters.sort,
      held: filters.kind === 'all' ? undefined : filters.kind,
      q,
      page: page > 1 ? page : undefined,
    });

  const sortGroup = $derived({
    key: 'sort',
    label: 'Sort',
    values: ['oldest', 'newest'] as const,
    labels: { oldest: 'Oldest first', newest: 'Newest first' },
    active: filters.sort,
    defaultValue: 'oldest',
    pill: true,
  } satisfies ChipGroup);
  const kindGroup = $derived({
    key: 'held',
    label: 'Show',
    values: HELD_FILTERS,
    labels: HELD_FILTER_LABELS,
    active: filters.kind,
    defaultValue: 'all',
    counts: held.facets,
    compact: true,
  } satisfies ChipGroup);

  const clearSearchHref = $derived(
    urlWith(pageState.url, { q: null, page: null, [SELECTION]: null })
  );
  // Amber once a song has waited a day, as the other triage queues mark someone waiting.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const waitedLong = (row: HeldSongRow) =>
    Date.now() - new Date(row.waitingSince).getTime() >= DAY_MS;

  const picking = (row: HeldSongRow) => ratingOpen && row.id === current;
  const rateIndex = (row: HeldSongRow) => heldDecisions(row.kind).indexOf('rate');
  const decisionsFor = (row: HeldSongRow) => {
    const enabled = heldDecisionsEnabled(live(row), canAct, canOpenHolds);
    return picking(row) ? ratingKeysEnabled(levelOf(row), enabled[rateIndex(row)]) : enabled;
  };

  function decide(row: HeldSongRow, index: number) {
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
    if (index === rateIndex(row)) {
      ratingOpen = true;
      return;
    }
    // A lyrics hold's one key is a link, which `pressDecisionKey` (buttons only) does not press.
    if (row.kind === 'lyrics') {
      document.querySelector<HTMLAnchorElement>('[data-triage-actions] a[data-triage-key="1"]')?.click();
      return;
    }
    pressDecisionKey(index);
  }

  function onkeydown(e: KeyboardEvent) {
    if (ratingOpen && e.key === 'Escape') {
      e.preventDefault();
      closeRating();
    }
  }

  const KIND_BADGE = { lyrics: 'Lyrics held', cover: 'Cover flagged', song: 'Song flagged' };
</script>

<svelte:window {onkeydown} />

{#snippet listHeader()}
  <div class="flex flex-col gap-2.5">
    {@render tabsBar()}
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <TriageFilterChips sort={sortGroup} selectionParam={SELECTION} />
    </div>
    <TriageFilterChips groups={[kindGroup]} selectionParam={SELECTION} />
  </div>
{/snippet}

{#snippet empty()}
  <div
    class="flex h-full flex-col items-center justify-center gap-1 p-5 text-center text-sm text-dark-0 in-[section]:hidden"
  >
    <IconZoomCancel class="mb-1.5 size-5 text-dark-2" aria-hidden="true" />
    <p class="m-0 font-medium text-white">
      No held songs{q ? ` match "${q}"` : ''}
    </p>
    <p class="m-0 text-xs text-dark-2">Search matches a song title, an owner username or an ID.</p>
    {#if q}
      <a href={clearSearchHref} class="text-xs {LINK_CLASS}">Clear search</a>
    {/if}
  </div>
  <p class="m-0 hidden text-sm text-dark-2 in-[section]:block">Select a song to review it.</p>
{/snippet}

<TriageShell
  flush
  rows={held.items}
  rowKey={(row: HeldSongRow) => row.id}
  parseKey={(raw) => Number(raw) || null}
  selectionParam={SELECTION}
  queueLabel="Held songs"
  itemLabel="Song"
  decisionEnabled={decisionsFor}
  decisionActions={['first', 'second', 'third', 'fourth']}
  ondecision={decide}
  ondecisionrefused={(row) => {
    // The digit of the level the song already has: nothing to change, so the picker closes.
    if (picking(row)) closeRating();
  }}
  outcomeFor={reportedOutcome}
  bind:current={() => current, select}
  pageNumber={page}
  hasMore={held.hasMore}
  offset={held.offset}
  total={held.total}
  {form}
  {listHeader}
  {empty}
>
  {#snippet listRow(row, state)}
    <TriageRow
      id={state.id}
      href={state.href}
      selected={state.selected}
      title={heldRowTitle(row)}
      meta={waitedLong(row) ? `held ${shortAge(row.waitingSince)}` : shortAge(row.waitingSince)}
      metaClass={waitedLong(row) ? 'text-amber-300' : 'text-dark-2'}
      coverUrl={live(row).coverUrl ?? undefined}
      verdict={state.verdict}
      error={state.error}
      onselect={state.select}
    >
      {#snippet coverIcon()}
        {#if row.withheld}<IconLock aria-hidden="true" />{:else}<IconMusic aria-hidden="true" />{/if}
      {/snippet}
      {#snippet badges()}
        <span class="rounded bg-amber-500/15 px-1.5 py-px text-[11px] font-medium text-amber-300">
          {KIND_BADGE[row.kind]}
        </span>
        {#if row.kind === 'lyrics'}
          <span class="rounded bg-dark-5 px-1.5 py-px text-[11px] font-medium text-dark-0">
            Decided in CSAM holds
          </span>
        {/if}
        {#if row.removed}<span class="text-[11px] text-dark-2 italic">Removed</span>{/if}
        {#if row.owner}
          <span class="ml-auto truncate text-xs text-dark-2">
            {row.owner.username ?? `User #${row.owner.id}`}
          </span>
        {/if}
      {/snippet}
    </TriageRow>
  {/snippet}
  {#snippet detail(row, state)}
    <HeldSongDetail
      row={live(row)}
      {civitaiUrl}
      {canAct}
      {canOpenHolds}
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

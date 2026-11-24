<script lang="ts">
  import type { Snippet } from 'svelte';
  import { IconMusic, IconPhoto, IconZoomCancel } from '@tabler/icons-svelte';
  import { page as pageState } from '$app/state';
  import TriageFilterChips, {
    type ChipGroup,
  } from '$lib/components/triage/TriageFilterChips.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import {
    APPEAL_DECISIONS,
    APPEAL_FILTER_LABELS,
    APPEAL_FILTERS,
    appealDecisionsEnabled,
    appealRowTitle,
    type AppealFilter,
    type AppealSort,
    type SongAppealRow,
  } from '$lib/audio-review';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import { pressDecisionKey } from '$lib/triage/decision-form';
  import { formActionHref } from '$lib/triage/queue';
  import { urlWith } from '$lib/url';
  import AppealSongDetail from './AppealSongDetail.svelte';

  // Audio review's Appeals tab: owners' Pending appeals of a removed song or of a song's removed
  // cover, decided with the image appeal resolver (docs/features/music.md "Moderating songs").
  let {
    appeals,
    filters,
    q,
    page,
    canAct,
    civitaiUrl,
    form,
    tabsBar,
  }: {
    appeals: {
      items: SongAppealRow[];
      hasMore: boolean;
      total: number;
      facets: Record<AppealFilter, number>;
      offset: number;
    };
    filters: { sort: AppealSort; kind: AppealFilter };
    q: string;
    page: number;
    canAct: boolean;
    civitaiUrl: string;
    /** The page's action result; TriageShell shows a refusal it names by `key`. */
    form: { error?: string; subject?: string; key?: string | number } | null | undefined;
    tabsBar: Snippet;
  } = $props();

  const SELECTION = 'selected';

  const actionHref = (action: string) =>
    formActionHref(action, {
      tab: 'appeals',
      sort: filters.sort === 'oldest' ? undefined : filters.sort,
      kind: filters.kind === 'all' ? undefined : filters.kind,
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
    key: 'kind',
    label: 'Show',
    values: APPEAL_FILTERS,
    labels: APPEAL_FILTER_LABELS,
    active: filters.kind,
    defaultValue: 'all',
    counts: appeals.facets,
    compact: true,
  } satisfies ChipGroup);

  const clearSearchHref = $derived(
    urlWith(pageState.url, { q: null, page: null, [SELECTION]: null })
  );
  // Amber once an appeal has waited a day, as the other triage queues mark someone waiting.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const waitedLong = (row: SongAppealRow) =>
    Date.now() - new Date(row.waitingSince).getTime() >= DAY_MS;

  const decisionsFor = (row: SongAppealRow) => appealDecisionsEnabled(row, canAct);
</script>

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
      No pending appeals{q ? ` match "${q}"` : ''}
    </p>
    <p class="m-0 text-xs text-dark-2">Search matches a song title, an owner username or an ID.</p>
    {#if q}
      <a href={clearSearchHref} class="text-xs {LINK_CLASS}">Clear search</a>
    {/if}
  </div>
  <p class="m-0 hidden text-sm text-dark-2 in-[section]:block">Select an appeal to review it.</p>
{/snippet}

<TriageShell
  flush
  rows={appeals.items}
  rowKey={(row: SongAppealRow) => row.id}
  parseKey={(raw) => Number(raw) || null}
  selectionParam={SELECTION}
  queueLabel="Appeals"
  itemLabel="Appeal of image"
  decisionEnabled={decisionsFor}
  decisionActions={APPEAL_DECISIONS}
  ondecision={(_row, index) => pressDecisionKey(index)}
  pageNumber={page}
  hasMore={appeals.hasMore}
  offset={appeals.offset}
  total={appeals.total}
  {form}
  {listHeader}
  {empty}
>
  {#snippet listRow(row, state)}
    <TriageRow
      id={state.id}
      href={state.href}
      selected={state.selected}
      title={appealRowTitle(row)}
      meta={waitedLong(row) ? `waiting ${shortAge(row.waitingSince)}` : shortAge(row.waitingSince)}
      metaClass={waitedLong(row) ? 'text-amber-300' : 'text-dark-2'}
      coverUrl={row.kind === 'song' ? row.coverUrl ?? undefined : undefined}
      verdict={state.verdict}
      error={state.error}
      onselect={state.select}
    >
      {#snippet coverIcon()}
        {#if row.kind === 'song'}<IconMusic aria-hidden="true" />{:else}<IconPhoto aria-hidden="true" />{/if}
      {/snippet}
      {#snippet badges()}
        <span class="rounded bg-blue-500/15 px-1.5 py-px text-[11px] font-medium text-blue-300">
          {row.kind === 'song' ? 'Song appeal' : 'Cover appeal'}
        </span>
        {#if row.removal?.reason}
          <span class="rounded bg-red-500/15 px-1.5 py-px text-[11px] font-medium text-red-300">
            {row.removal.reason}
          </span>
        {/if}
        {#if row.appeals > 1}
          <span class="rounded bg-amber-500/15 px-1.5 py-px text-[11px] font-medium text-amber-300">
            Repeat ×{row.appeals}
          </span>
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
    <AppealSongDetail
      {row}
      {civitaiUrl}
      {canAct}
      verdict={state.verdict}
      error={state.error}
      submit={state.submit}
      {actionHref}
    />
  {/snippet}
</TriageShell>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { IconMusic, IconPhoto } from '@tabler/icons-svelte';
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
  import { waitingMeta } from '$lib/format';
  import { pressDecisionKey } from '$lib/triage/decision-form';
  import { formActionHref } from '$lib/triage/queue';
  import AppealSongDetail from './AppealSongDetail.svelte';
  import QueueEmpty from './QueueEmpty.svelte';
  import { oldestNewestSort } from './queue';

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

  const sortGroup = $derived(oldestNewestSort(filters.sort));
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
  <QueueEmpty nothing="No pending appeals" q={q} pick="Select an appeal to review it." />
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
      {...waitingMeta(row.waitingSince)}
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

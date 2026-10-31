<script lang="ts">
  import { page } from '$app/state';
  import { SvelteMap } from 'svelte/reactivity';
  import {
    IconEyeOff,
    IconMessage,
    IconMessageCircle,
    IconUser,
  } from '@tabler/icons-svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { LINK_CLASS, plural } from '$lib/format';
  import { CSAM_HOLD_STATUS_LABELS, csamHoldFilterParams } from '$lib/csam-holds/hold-filters';
  import { pressDecisionKey } from '$lib/triage/decision-form';
  import { imageReveal } from '$lib/csam-holds/image-reveal.svelte';
  import { isDialogOpen, isRevealKey, isTypingTarget } from '$lib/triage/keys';
  import { formActionHref } from '$lib/triage/queue';
  import { urlWith } from '$lib/url';
  import CsamHoldDetail from './CsamHoldDetail.svelte';
  import CsamHoldFilters from './CsamHoldFilters.svelte';
  import HoldGroupChip from './HoldGroupChip.svelte';
  import type { AlsoResult } from './hold-author';
  import {
    decisionLabel,
    entityLabel,
    holdDecisionEnabled,
    holdMeta,
    holdTitle,
  } from './hold-entity';
  import type { ActionData, PageData } from './$types';

  let {
    data,
    form,
    canDecide,
    canStrike,
    canBan,
  }: {
    data: PageData;
    form: ActionData;
    canDecide: boolean;
    canStrike: boolean;
    canBan: boolean;
  } = $props();

  const onkeydown = (e: KeyboardEvent) => {
    const revealKey = isRevealKey({
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      repeat: e.repeat,
      defaultPrevented: e.defaultPrevented,
      isComposing: e.isComposing,
      typing: isTypingTarget(e.target as Element | null),
      dialogOpen: isDialogOpen(),
    });
    if (revealKey) imageReveal.toggle();
  };

  const parseKey = (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : null);

  const actionHref = (action: string) =>
    formActionHref(action, {
      ...csamHoldFilterParams(data.holdFilters, data.entityType),
      q: data.q || undefined,
      author: data.author ?? undefined,
      page: data.page > 1 ? data.page : undefined,
      limit: page.url.searchParams.get('limit') ?? undefined,
    });

  const clearFiltersHref = $derived(
    urlWith(page.url, { status: null, entityType: null, sort: null, q: null, author: null, page: null, hold: null })
  );
  const filtersActive = $derived(
    data.entityType !== null ||
      data.q !== '' ||
    data.author !== null ||
      Object.keys(csamHoldFilterParams(data.holdFilters)).length > 0
  );
  const grants = $derived({ canDecide, canStrike, canBan });
  const ondecision = (_row: unknown, index: number) => pressDecisionKey(index);

  // Other holds this decision covered: dimmed until the reload shows them decided. The summary survives that
  // reload and is dropped when filters, search or page change.
  const alsoDecided = new SvelteMap<number, string>();
  let alsoSummary = $state<{ done: number; failed: { holdId: number; error: string }[] } | null>(
    null
  );
  $effect(() => {
    void data.items;
    alsoDecided.clear();
  });
  // Filters, search and page only: advancing to the next hold changes the URL too, and the summary of
  // the decision just made has to outlive that.
  const queueView = $derived(
    JSON.stringify([csamHoldFilterParams(data.holdFilters, data.entityType), data.q, data.author, data.page])
  );
  $effect(() => {
    void queueView;
    alsoSummary = null;
  });
  const onothers = (decision: string, results: AlsoResult[]) => {
    const verdict =
      decision === 'dismiss' ? 'Dismissed with the same author’s hold' : 'Removed with the same author’s hold';
    for (const result of results) if (result.ok) alsoDecided.set(result.holdId, verdict);
    alsoSummary = {
      done: results.filter((r) => r.ok).length,
      failed: results.flatMap((r) => (r.ok ? [] : [{ holdId: r.holdId, error: r.error ?? 'Failed.' }])),
    };
  };

  const authorHref = (userId: number, chat = false) =>
    urlWith(page.url, {
      q: null,
      author: userId,
      status: 'pending',
      entityType: chat ? 'ChatMessage' : null,
      page: null,
      hold: null,
    });

  const statusLabel = $derived(
    data.holdFilters.status === 'all'
      ? ''
      : `${CSAM_HOLD_STATUS_LABELS[data.holdFilters.status].toLowerCase()} `
  );
</script>

<svelte:window {onkeydown} />

{#snippet empty()}
  <div class="p-5 text-sm text-dark-0">
    <p class="m-0">
      No {statusLabel}{data.entityType ? `${entityLabel(data.entityType).toLowerCase()} ` : ''}CSAM text
      holds{data.q || data.author !== null ? ' match that search' : ''}.
    </p>
    {#if filtersActive}
      <a href={clearFiltersHref} class="mt-2 inline-block {LINK_CLASS}">Clear filters</a>
    {/if}
  </div>
{/snippet}

{#snippet notice()}
  {#if data.author !== null}
    <p class="mx-6 mt-3 mb-0 text-[13px] text-dark-0" role="status">
      Showing the holds written by user #{data.author}.
      <a href={urlWith(page.url, { author: null, page: null, hold: null })} class={LINK_CLASS}>Show all</a>
    </p>
  {/if}
  {#if alsoSummary}
    <div class="mx-6 mt-3 flex items-start justify-between gap-3 rounded-lg border border-dark-4 bg-dark-7 px-3.5 py-2.5 text-[13px] text-dark-0" role="status">
      <div class="min-w-0">
        <p class="m-0">
          Applied to {plural(alsoSummary.done, 'other hold')} by the same author{alsoSummary.failed.length
            ? `; ${alsoSummary.failed.length} not applied:`
            : '.'}
        </p>
        {#if alsoSummary.failed.length}
          <ul class="m-0 mt-1 list-none space-y-0.5 p-0 text-dark-0">
            {#each alsoSummary.failed as f (f.holdId)}
              <li><MetaChip tone="red">failed</MetaChip> Hold #{f.holdId}: {f.error}</li>
            {/each}
          </ul>
        {/if}
      </div>
      <button type="button" class={LINK_CLASS} onclick={() => (alsoSummary = null)}>Dismiss</button>
    </div>
  {/if}
{/snippet}

{#snippet listHeader()}
  <CsamHoldFilters
    filters={data.holdFilters}
    entityType={data.entityType}
    typeCounts={data.typeCounts}
    pendingCount={data.pendingCount}
  />
{/snippet}

<TriageShell
  flush
  rows={data.items}
  rowKey={(row) => row.id}
  {parseKey}
  selectionParam="hold"
  queueLabel="CSAM text holds queue"
  itemLabel="Hold"
  settled={(row) => row.status !== 'Pending' || alsoDecided.has(row.id)}
  decisionEnabled={(row) => (alsoDecided.has(row.id) ? [] : holdDecisionEnabled(row, grants))}
  {ondecision}
  pageNumber={data.page}
  hasMore={data.hasMore}
  offset={data.offset}
  total={data.total}
  {form}
  {listHeader}
  {empty}
  {notice}
>
  {#snippet listRow(row, state)}
    <TriageRow
      id={state.id}
      href={state.href}
      selected={state.selected}
      title={holdTitle(row)}
      coverUrl={row.coverImages[0]?.url}
      coverType={row.coverImages[0]?.type}
      coverBlurred={!imageReveal.on}
      meta={holdMeta(row)}
      verdict={state.verdict ?? alsoDecided.get(row.id)}
      error={state.error}
      onselect={state.select}
    >
      {#snippet coverIcon()}
        {#if row.entityType === 'ChatMessage'}
          <IconMessage aria-hidden="true" />
        {:else if row.entityType === 'Comment' || row.entityType === 'CommentV2' || row.entityType === 'CommentV3'}
          <IconMessageCircle aria-hidden="true" />
        {:else if row.entityType === 'UserProfile'}
          <IconUser aria-hidden="true" />
        {:else}
          <IconEyeOff aria-hidden="true" />
        {/if}
      {/snippet}
      {#snippet badges()}
        <span class="block w-full truncate text-xs text-dark-0">{row.reason}</span>
        <MetaChip>{entityLabel(row.entityType)}</MetaChip>
        {#if row.redetected}<MetaChip tone="amber">re-detected</MetaChip>{/if}
        {#if row.cleanRescanAt && row.status === 'Pending'}<MetaChip tone="green">edited since</MetaChip>{/if}
        {#if row.userId !== null && row.otherPendingByAuthor > 0}
          <HoldGroupChip
            href={authorHref(row.userId)}
            title="Show this author’s pending holds"
          >
            same author ×{row.otherPendingByAuthor + 1}
          </HoldGroupChip>
        {/if}
        {#if row.userId !== null && row.otherPendingInChat > 0}
          <HoldGroupChip
            href={authorHref(row.userId, true)}
            title="Show this author’s pending holds in chats"
            tone="violet"
          >
            same chat
          </HoldGroupChip>
        {/if}
        {#if row.status !== 'Pending'}
          <MetaChip tone={row.status === 'Dismissed' ? 'neutral' : 'red'}>{decisionLabel(row)}</MetaChip>
        {/if}
      {/snippet}
    </TriageRow>
  {/snippet}
  {#snippet detail(row, state)}
    <CsamHoldDetail
      {row}
      civitaiUrl={data.civitaiUrl}
      {canDecide}
      {canStrike}
      {canBan}
      verdict={state.verdict ?? alsoDecided.get(row.id)}
      error={state.error}
      submit={state.submit}
      {actionHref}
      {onothers}
    />
  {/snippet}
</TriageShell>

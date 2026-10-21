<script lang="ts">
  import { page } from '$app/state';
  import {
    IconEyeOff,
    IconMessage,
    IconMessageCircle,
    IconUser,
  } from '@tabler/icons-svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { CSAM_HOLD_STATUS_LABELS, csamHoldFilterParams } from '$lib/csam-holds/hold-filters';
  import { pressDecisionKey } from '$lib/triage/decision-form';
  import { imageReveal } from '$lib/csam-holds/image-reveal.svelte';
  import { isDialogOpen, isRevealKey, isTypingTarget } from '$lib/triage/keys';
  import { formActionHref } from '$lib/triage/queue';
  import { urlWith } from '$lib/url';
  import CsamHoldDetail from './CsamHoldDetail.svelte';
  import CsamHoldFilters from './CsamHoldFilters.svelte';
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
      page: data.page > 1 ? data.page : undefined,
      limit: page.url.searchParams.get('limit') ?? undefined,
    });

  const clearFiltersHref = $derived(
    urlWith(page.url, { status: null, entityType: null, sort: null, q: null, page: null, hold: null })
  );
  const filtersActive = $derived(
    data.entityType !== null ||
      data.q !== '' ||
      Object.keys(csamHoldFilterParams(data.holdFilters)).length > 0
  );
  const grants = $derived({ canDecide, canStrike, canBan });
  const ondecision = (_row: unknown, index: number) => pressDecisionKey(index);

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
      holds{data.q ? ' match that search' : ''}.
    </p>
    {#if filtersActive}
      <a href={clearFiltersHref} class="mt-2 inline-block {LINK_CLASS}">Clear filters</a>
    {/if}
  </div>
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
  decisionEnabled={(row) => holdDecisionEnabled(row, grants)}
  {ondecision}
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
      title={holdTitle(row)}
      coverUrl={row.coverImages[0]?.url}
      coverBlurred={!imageReveal.on}
      meta={holdMeta(row)}
      verdict={state.verdict}
      error={state.error}
      onselect={state.select}
    >
      {#snippet coverIcon()}
        {#if row.entityType === 'ChatMessage'}
          <IconMessage aria-hidden="true" />
        {:else if row.entityType === 'Comment' || row.entityType === 'CommentV2'}
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
      verdict={state.verdict}
      error={state.error}
      submit={state.submit}
      {actionHref}
    />
  {/snippet}
</TriageShell>

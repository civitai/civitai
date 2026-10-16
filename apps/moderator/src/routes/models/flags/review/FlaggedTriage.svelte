<script lang="ts">
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
  import { HELD_DETECTION_RULING_CHOICES } from '$lib/ruling-choices';
  import { rulingDraft } from '$lib/ruling-draft.svelte';
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import FlaggedSourceBadge from '$lib/components/minor-flags/FlaggedSourceBadge.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import { flaggedDecisionEnabled } from '$lib/minor-flags/flagged-decision';
  import { flaggedFilterParams } from '$lib/minor-flags/flagged-filters';
  import { formActionHref } from '$lib/triage/queue';
  import type { FlaggedQueueData } from '$lib/server/minor-flag-queue';
  import type { FlaggedRow } from '$lib/server/minor-hash.service';
  import { urlWith } from '$lib/url';
  import FlaggedDetail from './FlaggedDetail.svelte';

  type QueueForm = { error?: string; subject?: string } | null;

  let {
    data,
    form,
  }: { data: FlaggedQueueData & { civitaiUrl: string }; form: QueueForm | undefined } = $props();

  type Verdict = ResolutionVerdict<'heldDetection'>;

  let current = $state<string | null>(null);
  const ruling = rulingDraft<Verdict>(() => current);

  // The `data-triage-action` of each hash row's two forms, in key order.
  const HASH_ACTIONS = ['keepFlag', 'liftFlag'] as const;

  const parseKey = (raw: string) => (/^\d+:(minor|poi):(hash|redetected)$/.test(raw) ? raw : null);

  // Carries the page's query so a no-JS submit re-renders the same queue.
  const actionHref = (action: string) =>
    formActionHref(action, {
      ...flaggedFilterParams(data.flaggedFilters),
      q: data.q || undefined,
      page: data.page > 1 ? data.page : undefined,
      limit: page.url.searchParams.get('limit') ?? undefined,
    });

  const clearFiltersHref = $derived(
    urlWith(page.url, { source: null, flag: null, sort: null, q: null, page: null, item: null })
  );
  const filtersActive = $derived(Object.keys(flaggedFilterParams(data.flaggedFilters)).length > 0);

  const ondecision = (row: FlaggedRow, index: number) => {
    if (row.source === 'redetected') {
      const verdict = HELD_DETECTION_RULING_CHOICES[index]?.verdict;
      if (verdict) ruling.choose(verdict);
      return;
    }
    // A hash flag has no reason to write, so the key submits straight away.
    document
      .querySelector<HTMLFormElement>(
        `[data-triage-actions] form[data-triage-action="${HASH_ACTIONS[index]}"]`
      )
      ?.requestSubmit();
  };
</script>

{#snippet empty()}
  <div class="p-5 text-sm text-dark-0">
    {#if data.q}
      <p class="m-0">Nothing matches "{data.q}".</p>
    {:else if filtersActive}
      <p class="m-0">No flags match these filters.</p>
    {:else}
      <p class="m-0">No automatic flags are waiting on a ruling.</p>
    {/if}
    {#if filtersActive || data.q}
      <a href={clearFiltersHref} class="mt-2 inline-block {LINK_CLASS}">Clear filters</a>
    {/if}
  </div>
{/snippet}

<TriageShell
  rows={data.items}
  rowKey={(row: FlaggedRow) => row.key}
  {parseKey}
  selectionParam="item"
  queueLabel="Flagged queue"
  itemLabel="Flag"
  decisionEnabled={flaggedDecisionEnabled}
  {ondecision}
  bind:current
  outcomeFor={(result, outcome) =>
    result.type === 'success' && result.data?.resolved === 'closed' ? 'Already flagged' : outcome}
  pageNumber={data.page}
  hasMore={data.hasMore}
  offset={data.offset}
  total={data.total}
  {form}
  {empty}
>
  {#snippet listRow(row, state)}
    <TriageRow
      id={state.id}
      href={state.href}
      selected={state.selected}
      title={row.modelName}
      meta={row.flaggedAt ? `flagged ${shortAge(row.flaggedAt)} ago` : 'flagged'}
      coverUrl={row.coverImages[0]?.url}
      verdict={state.verdict}
      error={state.error}
      onselect={state.select}
    >
      {#snippet badges()}
        <FlagBadge label={row.label} />
        <FlaggedSourceBadge {row} />
        {#if row.hasPendingAppeal}
          <Badge variant="outline" class="h-5 px-2 text-xs">also in Appeals</Badge>
        {/if}
        {#if row.daysLeft !== null}
          <span class="text-xs text-dark-2 tabular-nums">{row.daysLeft} d left</span>
        {/if}
      {/snippet}
    </TriageRow>
  {/snippet}
  {#snippet detail(row, state)}
    <FlaggedDetail
      {row}
      civitaiUrl={data.civitaiUrl}
      verdict={state.verdict}
      error={state.error}
      submit={state.submit}
      {actionHref}
      bind:draft={() => ruling.current, (d) => (ruling.current = d)}
    />
  {/snippet}
</TriageShell>

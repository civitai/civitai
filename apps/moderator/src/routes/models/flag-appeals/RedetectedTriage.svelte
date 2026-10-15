<script lang="ts">
  import { page } from '$app/state';
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import TriageRow from '$lib/components/minor-flags/TriageRow.svelte';
  import TriageShell from '$lib/components/minor-flags/TriageShell.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import { formActionHref } from '$lib/minor-flags/appeal-triage';
  import { redetectedFilterParams } from '$lib/minor-flags/redetected-filters';
  import type { RedetectedQueueData } from '$lib/server/minor-flag-queue';
  import type { RedetectedRow } from '$lib/server/minor-hash.service';
  import { urlWith } from '$lib/url';
  import RedetectedDetail from './RedetectedDetail.svelte';

  type QueueForm = { error?: string; modelId?: number } | null;

  let {
    data,
    form,
  }: { data: RedetectedQueueData & { civitaiUrl: string }; form: QueueForm | undefined } = $props();

  // A model can wait on both labels, so a row is identified by the pair.
  const rowKey = (row: RedetectedRow) => `${row.modelId}:${row.label}`;
  const parseKey = (raw: string) => (/^\d+:(minor|poi)$/.test(raw) ? raw : null);

  // Carries the page's query so a no-JS submit re-renders the same queue.
  const actionHref = (action: string) =>
    formActionHref(action, {
      view: 'redetected',
      ...redetectedFilterParams(data.redetectedFilters),
      q: data.q || undefined,
      page: data.page > 1 ? data.page : undefined,
      limit: page.url.searchParams.get('limit') ?? undefined,
    });

  const clearFiltersHref = $derived(
    urlWith(page.url, { flag: null, sort: null, q: null, page: null, item: null })
  );
  const filtersActive = $derived(Object.keys(redetectedFilterParams(data.redetectedFilters)).length > 0);
</script>

{#snippet empty()}
  <div class="p-5 text-sm text-dark-0">
    {#if data.q}
      <p class="m-0">Nothing matches "{data.q}".</p>
    {:else if filtersActive}
      <p class="m-0">No re-detections match these filters.</p>
    {:else}
      <p class="m-0">No labels are waiting on a re-detection.</p>
    {/if}
    {#if filtersActive || data.q}
      <a href={clearFiltersHref} class="mt-2 inline-block {LINK_CLASS}">Clear filters</a>
    {/if}
  </div>
{/snippet}

<TriageShell
  rows={data.items}
  {rowKey}
  {parseKey}
  selectionParam="item"
  queueLabel="Re-detected queue"
  itemLabel="Re-detection"
  canKeep={(row) => !row.hasPendingAppeal}
  canUnflag={(row) => !row.hasPendingAppeal}
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
      meta={row.redetected.at ? `detected ${shortAge(row.redetected.at)} ago` : 'detected'}
      coverUrl={row.coverImages[0]?.url}
      verdict={state.verdict}
      error={state.error}
      onselect={state.select}
    >
      {#snippet badges()}
        <FlagBadge label={row.label} />
      {/snippet}
    </TriageRow>
  {/snippet}
  {#snippet detail(row, state)}
    <RedetectedDetail
      {row}
      civitaiUrl={data.civitaiUrl}
      verdict={state.verdict}
      error={state.error}
      submit={state.submit}
      {actionHref}
    />
  {/snippet}
</TriageShell>

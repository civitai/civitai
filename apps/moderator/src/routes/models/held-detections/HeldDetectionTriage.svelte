<script lang="ts">
  import { page } from '$app/state';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
  import { HELD_DETECTION_RULING_CHOICES } from '$lib/ruling-choices';
  import { rulingDraft } from '$lib/ruling-draft.svelte';
  import DetectionKindBadge from '$lib/components/minor-flags/DetectionKindBadge.svelte';
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import { detectionKind } from '$lib/minor-flags/text-scan-verdicts';
  import { formActionHref } from '$lib/triage/queue';
  import { redetectedFilterParams } from '$lib/minor-flags/redetected-filters';
  import type { RedetectedQueueData } from '$lib/server/minor-flag-queue';
  import type { RedetectedRow } from '$lib/server/minor-hash.service';
  import { urlWith } from '$lib/url';
  import HeldDetectionDetail from './HeldDetectionDetail.svelte';

  type QueueForm = { error?: string; modelId?: number } | null;

  let {
    data,
    form,
  }: { data: RedetectedQueueData & { civitaiUrl: string }; form: QueueForm | undefined } = $props();

  type Verdict = ResolutionVerdict<'heldDetection'>;

  let current = $state<string | null>(null);
  const ruling = rulingDraft<Verdict>(() => current);

  // A model can wait on both labels, so a row is identified by the pair.
  const rowKey = (row: RedetectedRow) => `${row.modelId}:${row.label}`;
  const parseKey = (raw: string) => (/^\d+:(minor|poi)$/.test(raw) ? raw : null);

  // Carries the page's query so a no-JS submit re-renders the same queue.
  const actionHref = (action: string) =>
    formActionHref(action, {
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
      <p class="m-0">No detections match these filters.</p>
    {:else}
      <p class="m-0">No detections are waiting on a ruling.</p>
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
  queueLabel="Held detections queue"
  itemLabel="Detection"
  decisionEnabled={(row) => [!row.hasPendingAppeal, !row.hasPendingAppeal]}
  ondecision={(_row, index) => {
    const verdict = HELD_DETECTION_RULING_CHOICES[index]?.verdict;
    if (verdict) ruling.choose(verdict);
  }}
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
      meta={row.redetected.at ? `detected ${shortAge(row.redetected.at)} ago` : 'detected'}
      coverUrl={row.coverImages[0]?.url}
      verdict={state.verdict}
      error={state.error}
      onselect={state.select}
    >
      {#snippet badges()}
        <FlagBadge label={row.label} />
        <DetectionKindBadge kind={detectionKind(row.redetected)} />
      {/snippet}
    </TriageRow>
  {/snippet}
  {#snippet detail(row, state)}
    <HeldDetectionDetail
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

<script lang="ts">
  import { page } from '$app/state';
  import { IconInfoCircle } from '@tabler/icons-svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { LINK_CLASS, shortAge } from '$lib/format';
  import type { MatchesQueueData } from '$lib/server/minor-flag-queue';
  import type { MinorHashReviewRow } from '$lib/server/minor-hash.service';
  import { formActionHref } from '$lib/triage/queue';
  import { urlWith } from '$lib/url';
  import MatchesDetail from './MatchesDetail.svelte';

  type QueueForm = { error?: string; subject?: string } | null;

  let {
    data,
    form,
  }: { data: MatchesQueueData & { civitaiUrl: string }; form: QueueForm | undefined } = $props();

  // The `data-triage-action` of each decision's form, in key order.
  const ACTIONS = ['setMinor', 'dismiss'] as const;
  const BOTH_ENABLED = [true, true] as const;

  const parseKey = (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : null);

  // Carries the page's query so a no-JS submit re-renders the same queue.
  const actionHref = (action: string) =>
    formActionHref(action, {
      q: data.q || undefined,
      page: data.page > 1 ? data.page : undefined,
      limit: page.url.searchParams.get('limit') ?? undefined,
    });

  const clearSearchHref = $derived(urlWith(page.url, { q: null, page: null, item: null }));
</script>

{#snippet listHeader()}
  <p class="m-0 flex items-start gap-2 text-xs leading-[1.45] text-dark-1">
    <IconInfoCircle class="mt-px size-3.5 shrink-0" aria-hidden="true" />
    <span>
      Minor only. Unflagged models that share a file with a minor-flagged model, from a different
      uploader. Same-uploader matches are auto-flagged and sit in Flagged.
    </span>
  </p>
{/snippet}

{#snippet empty()}
  <div class="p-5 text-sm text-dark-0">
    {#if data.q}
      <p class="m-0">Nothing matches "{data.q}".</p>
      <a href={clearSearchHref} class="mt-2 inline-block {LINK_CLASS}">Clear search</a>
    {:else}
      <p class="m-0">No file matches are waiting.</p>
    {/if}
  </div>
{/snippet}

<TriageShell
  flush
  rows={data.items}
  rowKey={(row: MinorHashReviewRow) => row.modelId}
  {parseKey}
  selectionParam="item"
  queueLabel="File matches queue"
  itemLabel="Match"
  decisionEnabled={() => BOTH_ENABLED}
  decisionActions={ACTIONS}
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
      title={row.modelName}
      meta="uploaded {shortAge(row.createdAt)}"
      coverUrl={row.coverImages[0]?.url}
      verdict={state.verdict}
      error={state.error}
      onselect={state.select}
    >
      {#snippet badges()}
        <MetaChip truncate>shares file with {row.minorModelName ?? `model #${row.minorModelId}`}</MetaChip>
      {/snippet}
    </TriageRow>
  {/snippet}
  {#snippet detail(row, state)}
    <MatchesDetail
      {row}
      civitaiUrl={data.civitaiUrl}
      verdict={state.verdict}
      error={state.error}
      submit={state.submit}
      {actionHref}
      formActions={ACTIONS}
    />
  {/snippet}
</TriageShell>

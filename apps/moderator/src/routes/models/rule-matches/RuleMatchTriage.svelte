<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { SvelteMap } from 'svelte/reactivity';
  import { IconFileText } from '@tabler/icons-svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import OwnerGroupChip from '$lib/components/model-rule-holds/OwnerGroupChip.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { LINK_CLASS, plural, shortAge } from '$lib/format';
  import {
    MODEL_RULE_HOLD_STATUS_LABELS,
    heldOutcome,
    holdDecisionEnabled,
    modeLabel,
    modelRuleHoldFilterParams,
  } from '$lib/model-rule-holds';
  import type { OwnerResult } from '$lib/model-rule-holds-context';
  import { pressDecisionKey } from '$lib/triage/decision-form';
  import { formActionHref } from '$lib/triage/queue';
  import { urlWith } from '$lib/url';
  import RuleMatchDetail from './RuleMatchDetail.svelte';
  import RuleMatchFilters from './RuleMatchFilters.svelte';
  import type { ActionData, PageData } from './$types';

  let {
    data,
    form,
    canStrike,
  }: { data: PageData; form: ActionData; canStrike: boolean } = $props();

  // SvelteKit keeps the page's `form` until the next submit, so a reload alone leaves its refusal on
  // screen. Remember which one the moderator reloaded away; a newer refusal is a different object.
  let reloadedForm = $state<ActionData>(null);
  const shownForm = $derived(form === reloadedForm ? null : form);
  const reloadQueue = () => {
    reloadedForm = form;
    void invalidateAll();
  };

  const parseKey = (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : null);

  const actionHref = (action: string) =>
    formActionHref(action, {
      ...modelRuleHoldFilterParams(data.holdFilters),
      q: data.q || undefined,
      owner: data.owner ?? undefined,
      page: data.page > 1 ? data.page : undefined,
      limit: page.url.searchParams.get('limit') ?? undefined,
    });

  const clearFiltersHref = $derived(
    urlWith(page.url, {
      status: null,
      mode: null,
      sort: null,
      rule: null,
      q: null,
      owner: null,
      page: null,
      hold: null,
    })
  );
  const filtersActive = $derived(
    data.q !== '' ||
      data.owner !== null ||
      Object.keys(modelRuleHoldFilterParams(data.holdFilters)).length > 0
  );
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
  const queueView = $derived(
    JSON.stringify([modelRuleHoldFilterParams(data.holdFilters), data.q, data.owner, data.page])
  );
  $effect(() => {
    void queueView;
    alsoSummary = null;
  });
  const onothers = (_decision: string, results: OwnerResult[]) => {
    for (const result of results)
      if (result.ok) alsoDecided.set(result.holdId, 'Decided with the same owner’s hold');
    alsoSummary = {
      done: results.filter((r) => r.ok).length,
      failed: results.flatMap((r) => (r.ok ? [] : [{ holdId: r.holdId, error: r.error ?? 'Failed.' }])),
    };
  };

  const ownerHref = (userId: number) =>
    urlWith(page.url, { q: null, owner: userId, status: 'pending', page: null, hold: null });

  const statusLabel = $derived(
    data.holdFilters.status === 'all'
      ? ''
      : `${MODEL_RULE_HOLD_STATUS_LABELS[data.holdFilters.status].toLowerCase()} `
  );
  const subjectsOf = (rules: { subject: string }[]) =>
    rules.map((rule) => rule.subject).join(', ') || 'no rule stored';
</script>

{#snippet empty()}
  <div class="p-5 text-sm text-dark-0">
    <p class="m-0">
      No {statusLabel}model rule matches{data.q || data.owner !== null ? ' match that search' : ''}.
    </p>
    {#if filtersActive}
      <a href={clearFiltersHref} class="mt-2 inline-block {LINK_CLASS}">Clear filters</a>
    {/if}
  </div>
{/snippet}

{#snippet notice()}
  {#if data.owner !== null}
    <p class="mx-6 mt-3 mb-0 text-[13px] text-dark-0" role="status">
      Showing the matches on models of user #{data.owner}.
      <a href={urlWith(page.url, { owner: null, page: null, hold: null })} class={LINK_CLASS}>Show all</a>
    </p>
  {/if}
  {#if alsoSummary}
    <div
      class="mx-6 mt-3 flex items-start justify-between gap-3 rounded-lg border border-dark-4 bg-dark-7 px-3.5 py-2.5 text-[13px] text-dark-0"
      role="status"
    >
      <div class="min-w-0">
        <p class="m-0">
          Applied to {plural(alsoSummary.done, 'other hold')} by the same owner{alsoSummary.failed.length
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
  <RuleMatchFilters filters={data.holdFilters} pendingCount={data.pendingCount} rules={data.rules} />
{/snippet}

<TriageShell
  flush
  rows={data.items}
  rowKey={(row) => row.id}
  {parseKey}
  selectionParam="hold"
  queueLabel="Model rule matches queue"
  itemLabel="Match"
  settled={(row) => row.status !== 'Pending' || alsoDecided.has(row.id)}
  decisionEnabled={(row) => (alsoDecided.has(row.id) ? [] : holdDecisionEnabled(row, { canStrike }))}
  {ondecision}
  pageNumber={data.page}
  hasMore={data.hasMore}
  offset={data.offset}
  total={undefined}
  form={shownForm}
  {listHeader}
  {empty}
  {notice}
>
  {#snippet listRow(row, state)}
    <TriageRow
      id={state.id}
      href={state.href}
      selected={state.selected}
      title={row.modelName ?? `Model #${row.modelId}`}
      coverUrl={row.coverImages[0]?.url}
      coverType={row.coverImages[0]?.type}
      meta={shortAge(row.createdAt)}
      verdict={state.verdict ?? alsoDecided.get(row.id)}
      error={state.error}
      onselect={state.select}
    >
      {#snippet coverIcon()}
        <IconFileText aria-hidden="true" />
      {/snippet}
      {#snippet badges()}
        <span class="block w-full truncate text-xs text-dark-0">{subjectsOf(row.rules)}</span>
        <MetaChip tone={row.mode === 'active' ? 'amber' : 'blue'}>{modeLabel(row.mode)}</MetaChip>
        {#if row.applied}<MetaChip tone="red">applied</MetaChip>{/if}
        {#if row.redetected}<MetaChip tone="amber">re-detected</MetaChip>{/if}
        {#if row.source === 'training'}<MetaChip tone="amber">Training</MetaChip>{/if}
        {#if row.uploadType === 'Trained'}<MetaChip>Trained on Civitai</MetaChip>{/if}
        {#if row.editedSince}<MetaChip tone="green">edited since</MetaChip>{/if}
        {#if row.userId !== null && row.otherPendingByOwner > 0}
          <OwnerGroupChip href={ownerHref(row.userId)} title="Show this owner’s pending matches">
            same owner ×{row.otherPendingByOwner + 1}
          </OwnerGroupChip>
        {/if}
        {#if row.status !== 'Pending'}
          <MetaChip tone={row.status === 'Dismissed' ? 'neutral' : 'red'}>{heldOutcome(row)}</MetaChip>
        {/if}
      {/snippet}
    </TriageRow>
  {/snippet}
  {#snippet detail(row, state)}
    <RuleMatchDetail
      {row}
      civitaiUrl={data.civitaiUrl}
      {canStrike}
      verdict={state.verdict ?? alsoDecided.get(row.id)}
      error={state.error}
      submit={state.submit}
      {actionHref}
      {onothers}
      onreload={reloadQueue}
    />
  {/snippet}
</TriageShell>

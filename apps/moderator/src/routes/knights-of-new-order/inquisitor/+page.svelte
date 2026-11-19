<script lang="ts">
  import TriagePageHeader from '$lib/components/triage/TriagePageHeader.svelte';
  import TriageParamTabs from '$lib/components/triage/TriageParamTabs.svelte';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { shortAge } from '$lib/format';
  import {
    DEFAULT_INQUISITOR_FILTER,
    INQUISITOR_FILTER_LABELS,
    INQUISITOR_FILTERS,
    type InquisitorFilter,
  } from '$lib/knights/inquisitor-filters';
  import type { InquisitorItem } from '$lib/server/knights/inquisitor.service';
  import { pressDecisionKey } from '$lib/triage/decision-form';
  import { formActionHref } from '$lib/triage/queue';
  import InquisitorChips from './InquisitorChips.svelte';
  import InquisitorDetail, { inquisitorDecisionsEnabled } from './InquisitorDetail.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const SELECTION = 'selected';
  // Four segments share the 400px list column, so each tab gets one word; hover shows the full name.
  const TAB_LABELS: Record<InquisitorFilter, string> = {
    all: 'All',
    blocked: 'Blocked',
    'pushed-down': 'Pushed',
    'write-back': 'Conflict',
  };
  const tabs = INQUISITOR_FILTERS.map((value) => ({
    value,
    label: TAB_LABELS[value],
    hint: INQUISITOR_FILTER_LABELS[value],
  }));
  const actionHref = (action: string) =>
    formActionHref(action, {
      filter: data.filter === DEFAULT_INQUISITOR_FILTER ? undefined : data.filter,
    });
</script>

{#snippet listHeader()}
  <TriageParamTabs
    {tabs}
    current={data.filter}
    param="filter"
    defaultValue={DEFAULT_INQUISITOR_FILTER}
    label="Why it is here"
    selectionParam={SELECTION}
    counts={data.counts}
  />
{/snippet}

{#snippet empty()}
  <p class="m-0 p-6 text-center text-sm text-dark-2">
    {data.filter === DEFAULT_INQUISITOR_FILTER
      ? 'No images are waiting for an Inquisitor ruling.'
      : `Nothing waiting under “${INQUISITOR_FILTER_LABELS[data.filter]}”.`}
  </p>
{/snippet}

<div class="flex flex-col lg:h-svh">
  <TriagePageHeader
    title="Knights of New Order Inquisitor queue"
    subtitle="Images the Knights could not settle. Your rating is set on the image as a moderator ruling and every pending vote is graded against it."
  />
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <TriageShell
      flush
      rows={data.items}
      rowKey={(row: InquisitorItem) => row.id}
      parseKey={(raw) => Number(raw) || null}
      selectionParam={SELECTION}
      queueLabel="Inquisitor queue"
      itemLabel="Image"
      decisionEnabled={inquisitorDecisionsEnabled}
      ondecision={(_row, index) => pressDecisionKey(index)}
      pageNumber={1}
      hasMore={false}
      offset={0}
      total={Math.min(data.counts[data.filter], data.limit)}
      {form}
      {listHeader}
      {empty}
    >
      {#snippet listRow(row, state)}
        <TriageRow
          id={state.id}
          href={state.href}
          selected={state.selected}
          title="Image #{row.imageId}"
          meta={shortAge(row.createdAt)}
          coverUrl={row.imageKey}
          coverType={row.imageType}
          verdict={state.verdict}
          error={state.error}
          onselect={state.select}
        >
          {#snippet badges()}
            <InquisitorChips {row} />
            {#if row.votes[0]}
              <span class="basis-full truncate text-xs text-dark-2">
                Knights lean {row.votes[0].label} · {row.votes.reduce((sum, v) => sum + v.votes, 0)} votes
              </span>
            {/if}
          {/snippet}
        </TriageRow>
      {/snippet}
      {#snippet detail(row, state)}
        <InquisitorDetail
          {row}
          verdict={state.verdict}
          error={state.error}
          submit={state.submit}
          {actionHref}
        />
      {/snippet}
    </TriageShell>
  </div>
  {#if data.counts[data.filter] > data.limit}
    <p class="m-0 border-t border-dark-4 px-3 py-1.5 text-xs text-dark-2">
      Showing the first {data.limit} of {data.counts[data.filter]}. Refresh the queue once they are ruled for the next ones.
    </p>
  {/if}
</div>

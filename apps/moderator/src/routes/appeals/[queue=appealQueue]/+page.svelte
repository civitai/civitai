<script lang="ts">
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import TriageRow from '$lib/components/triage/TriageRow.svelte';
  import TriageShell from '$lib/components/triage/TriageShell.svelte';
  import { shortAge } from '$lib/format';
  import { appealRulingChoices } from '$lib/ruling-choices';
  import { rulingDraft } from '$lib/ruling-draft.svelte';
  import type { SiteAppealRow } from '$lib/server/site-appeals.service';
  import { approvalEffect, outcomeLabel, rowTitle } from './site-appeal-display';
  import SiteAppealDetail from './SiteAppealDetail.svelte';
  import type { ActionData, PageData } from './$types';

  type Verdict = ResolutionVerdict<'appeal'>;

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const CHOICES = appealRulingChoices();
  const canBan = $derived(data.grants['user.ban'] === true);
  let current = $state<number | null>(null);
  const ruling = rulingDraft<Verdict>(() => current);
</script>

<div class="flex flex-col gap-3 px-6 pb-4 lg:h-[calc(100svh-3rem)]">
  <h1 class="m-0 text-xl font-semibold text-white">{data.queue.title}</h1>

  <TriageShell
    rows={data.items}
    rowKey={(row: SiteAppealRow) => row.id}
    parseKey={(raw) => Number(raw) || null}
    selectionParam="appeal"
    queueLabel="Appeal queue"
    itemLabel="Appeal"
    decisionEnabled={(row) => [!approvalEffect(row.subject, canBan).blocked, true]}
    ondecision={(_row, index) => {
      const verdict = CHOICES[index]?.verdict;
      if (verdict) ruling.choose(verdict);
    }}
    outcomeFor={outcomeLabel}
    bind:current
    pageNumber={data.page}
    hasMore={data.hasMore}
    offset={data.offset}
    total={data.total}
    {form}
  >
    {#snippet listRow(row, state)}
      <TriageRow
        id={state.id}
        href={state.href}
        selected={state.selected}
        title={rowTitle(row)}
        meta="waiting {shortAge(row.createdAt)}"
        cover={false}
        verdict={state.verdict}
        error={state.error}
        onselect={state.select}
      >
        {#snippet badges()}
          <span class="text-sm text-dark-2">{row.username ?? `#${row.userId}`}</span>
          {#if row.priors.length}
            <Badge variant="secondary">Repeat ×{row.priors.length + 1}</Badge>
          {/if}
        {/snippet}
      </TriageRow>
    {/snippet}
    {#snippet detail(row, state)}
      <SiteAppealDetail
        {row}
        civitaiUrl={data.civitaiUrl}
        {canBan}
        choices={CHOICES}
        verdict={state.verdict}
        error={state.error}
        submit={state.submit}
        bind:draft={() => ruling.current, (d) => (ruling.current = d)}
      />
    {/snippet}
    {#snippet empty()}
      <p class="m-0 p-5 text-sm text-dark-0">No open appeals in this queue.</p>
    {/snippet}
  </TriageShell>
</div>

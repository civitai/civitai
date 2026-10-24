<script lang="ts">
  import { page } from '$app/state';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import { LINK_CLASS, dateTime, shortAge, type Jsonified } from '$lib/format';
  import { heldOutcome, modeLabel } from '$lib/model-rule-holds';
  import type { ModelRuleHoldHistoryEntry } from '$lib/server/model-rule-holds.queries';
  import { urlWith } from '$lib/url';

  let {
    modelId,
    history,
  }: {
    modelId: number;
    /** Null when the read failed. */
    history: Promise<Jsonified<ModelRuleHoldHistoryEntry>[] | null>;
  } = $props();

  // Searching the model id lists every hold it has had, so the earlier ruling is on the page the link opens.
  const holdHref = (holdId: number) =>
    urlWith(page.url, { hold: holdId, status: 'all', q: modelId, owner: null, page: null });
</script>

<TriageCard dense title="History">
  {#await history}
    <p class="m-0 text-dark-2">…</p>
  {:then entries}
    {#if entries === null}
      <p class="m-0 text-dark-2">could not load</p>
    {:else if entries.length}
      <ul class="m-0 list-none space-y-2 p-0">
        {#each entries as entry (entry.id)}
          <li class="text-dark-0">
            <span class="flex flex-wrap items-center gap-1.5">
              <MetaChip tone={entry.status === 'Pending' ? 'amber' : entry.status === 'Confirmed' ? 'red' : 'neutral'}>
                {entry.status === 'Pending'
                  ? 'pending'
                  : heldOutcome({ status: entry.status, decision: entry.decision, mode: entry.mode })}
              </MetaChip>
              <MetaChip>{modeLabel(entry.mode)}</MetaChip>
              <span>
                {entry.subjects.join(', ') || 'no rule stored'}
              </span>
            </span>
            <span class="block text-[11px] text-dark-2" title={dateTime(entry.createdAt)}>
              held {shortAge(entry.createdAt)} ago{entry.decidedAt
                ? ` · decided by ${entry.decidedByUsername ?? 'an unknown moderator'} ${shortAge(entry.decidedAt)} ago`
                : ''} ·
              <a href={holdHref(entry.id)} class={LINK_CLASS}>See that hold</a>
            </span>
            {#if entry.decisionNote}
              <span class="block text-[12px] break-words whitespace-pre-wrap">{entry.decisionNote}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="m-0 text-dark-2">No earlier model-rule holds on this model.</p>
    {/if}
  {:catch}
    <p class="m-0 text-dark-2">could not load</p>
  {/await}
</TriageCard>

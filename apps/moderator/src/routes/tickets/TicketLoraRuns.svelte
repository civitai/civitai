<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { dateTime, relativeTime } from '$lib/format';
  import { trainingStatusLabel } from '$lib/tickets/labels';
  import type { LoraRun, TicketLora } from '$lib/server/tickets/lora-runs';
  import { TRAINING_MODELS_PATH } from '$lib/tickets/lora-panel';
  import TicketCardState from './TicketCardState.svelte';
  import TicketPublishBlock from './TicketPublishBlock.svelte';
  import TicketSection from './TicketSection.svelte';

  let {
    ticketId,
    lora,
    ondone,
  }: {
    ticketId: string;
    lora: TicketLora;
    ondone: (what: string, data: Record<string, unknown> | undefined) => void;
  } = $props();

  // The page's username filter is an exact match.
  const queueUrl = (username: string | null) =>
    username ? `${TRAINING_MODELS_PATH}?username=${encodeURIComponent(username)}` : TRAINING_MODELS_PATH;

  // The block is on the model, and a model can have several runs: one control, on its newest run.
  const lead = $derived.by(() => {
    if (lora.status !== 'ok') return new Set<number>();
    const seen = new Set<number>();
    const ids = new Set<number>();
    for (const r of lora.runs) {
      if (seen.has(r.modelId)) continue;
      seen.add(r.modelId);
      ids.add(r.modelVersionId);
    }
    return ids;
  });
</script>

<TriageCard title="LoRA trainer" dense>
  {#if lora.status !== 'ok'}
    <TicketCardState
      card={lora}
      unlinked="training runs unavailable"
      unavailable="Training runs unavailable."
    />
  {:else}
    {@const { userId } = lora}
    {#snippet run(r: LoraRun)}
      <div>
        <span class="text-white">{r.modelName ?? `Model #${r.modelId}`}</span>
        {#if r.name}<span class="text-dark-2"> · {r.name}</span>{/if}
        · {r.status ? trainingStatusLabel(r.status) : 'No status'}
        {#if r.createdAt}
          · <span class="text-dark-2" title={dateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span>
        {/if}
        {#if r.updatedAt}
          <span class="text-dark-2"> · finished <span title={dateTime(r.updatedAt)}>{relativeTime(r.updatedAt)}</span></span>
        {/if}
        {#if r.cannotPublish}<Badge variant="destructive">Blocked from publishing</Badge>{/if}
      </div>
      {#if lead.has(r.modelVersionId)}
        <TicketPublishBlock {ticketId} {userId} modelId={r.modelId} cannotPublish={r.cannotPublish} {ondone} />
      {/if}
    {/snippet}
    <TicketSection
      title="Training runs"
      section={{ status: 'ok', rows: lora.runs, truncated: lora.truncated }}
      href={queueUrl(lora.username)}
      linkLabel="Training Models"
      empty="No training runs."
      row={run}
      rowKey={(r) => r.modelVersionId}
      listClass="gap-2"
      itemClass="flex min-w-0 flex-col gap-1 break-words"
    />
  {/if}
</TriageCard>

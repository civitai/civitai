<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, relativeTime } from '$lib/format';
  import type { TicketLora } from '$lib/server/tickets/lora-runs';
  import { TRAINING_MODELS_PATH } from '$lib/tickets/lora-panel';
  import TicketPublishBlock from './TicketPublishBlock.svelte';

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
  {#if lora.status === 'unlinked'}
    <p class="m-0 text-dark-2">No linked Civitai account — training runs unavailable</p>
  {:else if lora.status === 'unavailable'}
    <p class="m-0 text-amber-300">
      Training runs unavailable.
      <a class={LINK_CLASS} href={userLookupUrl(lora.userId, 'basic')}>User #{lora.userId}</a>
    </p>
  {:else}
    {@const { runs, truncated, userId, username } = lora}
    <div class="flex flex-col gap-1">
      <div class="flex items-baseline justify-between gap-2">
        <span class="font-medium text-white">Training runs</span>
        <a class={LINK_CLASS} href={queueUrl(username)}>{truncated ? 'All in Training Models' : 'Training Models'}</a>
      </div>
      {#if runs.length === 0}
        <p class="m-0 text-dark-2">No training runs.</p>
      {:else}
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          {#each runs as r (r.modelVersionId)}
            <li class="flex min-w-0 flex-col gap-1 break-words">
              <div>
                <span class="text-white">{r.modelName ?? `Model #${r.modelId}`}</span>
                {#if r.name}<span class="text-dark-2"> · {r.name}</span>{/if}
                · {r.status ?? 'No status'}
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
            </li>
          {/each}
        </ul>
        {#if truncated}<p class="m-0 text-dark-2">Showing the newest {runs.length}.</p>{/if}
      {/if}
    </div>
  {/if}
</TriageCard>

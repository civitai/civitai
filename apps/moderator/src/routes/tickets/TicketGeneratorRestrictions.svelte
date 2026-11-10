<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { dateTime, relativeTime } from '$lib/format';
  import { restrictionStatusLabel } from '$lib/tickets/labels';
  import { GENERATOR_RESTRICTIONS_PATH, RESTRICTION_TYPE_LABELS } from '$lib/restriction-types';
  import type {
    GeneratorBlockedPrompt,
    GeneratorRestriction,
    TicketGenerator,
  } from '$lib/server/tickets/generator-restrictions';
  import TicketCardState from './TicketCardState.svelte';
  import TicketRestrictionRuling from './TicketRestrictionRuling.svelte';
  import TicketSection from './TicketSection.svelte';

  let {
    ticketId,
    generator,
    ondone,
  }: {
    ticketId: string;
    generator: TicketGenerator;
    ondone: (what: string, data: Record<string, unknown> | undefined) => void;
  } = $props();

  // The queue's search takes a bare number as a user id.
  const queueUrl = (userId: number) => `${GENERATOR_RESTRICTIONS_PATH}?q=${userId}&status=any`;
  const typeLabel = (t: string) => (t in RESTRICTION_TYPE_LABELS ? RESTRICTION_TYPE_LABELS[t as keyof typeof RESTRICTION_TYPE_LABELS] : t);
</script>

<TriageCard title="Image generator" dense>
  {#if generator.status !== 'ok'}
    <TicketCardState
      card={generator}
      unlinked="restrictions and blocked prompts unavailable"
      unavailable="Image generator context unavailable."
    />
  {:else}
    {@const { restrictions, blockedPrompts, userId } = generator}
    <div class="flex flex-col gap-3">
      {#snippet restriction(r: GeneratorRestriction)}
        <div>
          <span class="text-white">{typeLabel(r.type)} #{r.id}</span>
          · <span class={r.status === 'Pending' ? 'text-amber-300' : ''}>{restrictionStatusLabel(r.status)}</span>
          · {r.triggerCount} trigger{r.triggerCount === 1 ? '' : 's'}
          · <span class="text-dark-2" title={dateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span>
          {#if r.resolvedAt}
            <span class="text-dark-2"> · ruled <span title={dateTime(r.resolvedAt)}>{relativeTime(r.resolvedAt)}</span></span>
          {/if}
        </div>
        {#if r.rulable}
          <TicketRestrictionRuling
            {ticketId}
            {userId}
            restrictionId={r.id}
            action="generatorResolveRestriction"
            {ondone}
          />
        {/if}
      {/snippet}
      {#if restrictions}
        <TicketSection
          title="Generation restrictions"
          section={restrictions}
          href={queueUrl(userId)}
          linkLabel="Restriction queue"
          truncatedLabel="All in the queue"
          empty="No restrictions."
          row={restriction}
          rowKey={(r) => r.id}
          listClass="gap-2"
          itemClass="flex min-w-0 flex-col gap-1 break-words"
        />
      {/if}

      {#snippet blockedPrompt(p: GeneratorBlockedPrompt)}
        <span class="text-dark-2" title={dateTime(p.time)}>{relativeTime(p.time)} · {p.source}</span>
        <div class="whitespace-pre-wrap text-white">{p.prompt}</div>
        {#if p.negativePrompt}<div class="whitespace-pre-wrap text-dark-2">Negative: {p.negativePrompt}</div>{/if}
      {/snippet}
      {#if blockedPrompts}
        <TicketSection
          title="Blocked prompts"
          section={blockedPrompts}
          href={userLookupUrl(userId, 'basic')}
          empty="No blocked prompts."
          row={blockedPrompt}
          rowKey={(p) => p.key}
          listClass="gap-1.5"
        />
      {/if}
    </div>
  {/if}
</TriageCard>

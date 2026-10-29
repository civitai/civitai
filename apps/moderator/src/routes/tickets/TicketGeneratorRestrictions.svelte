<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, relativeTime } from '$lib/format';
  import { GENERATOR_RESTRICTIONS_PATH, RESTRICTION_TYPE_LABELS } from '$lib/restriction-types';
  import type { TicketGenerator } from '$lib/server/tickets/generator-restrictions';
  import TicketRestrictionRuling from './TicketRestrictionRuling.svelte';

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
  {#if generator.status === 'unlinked'}
    <p class="m-0 text-dark-2">No linked Civitai account — restrictions and blocked prompts unavailable</p>
  {:else if generator.status === 'unavailable'}
    <p class="m-0 text-amber-300">
      Image generator context unavailable.
      <a class={LINK_CLASS} href={userLookupUrl(generator.userId, 'basic')}>User #{generator.userId}</a>
    </p>
  {:else}
    {@const { restrictions, blockedPrompts, userId } = generator}
    <div class="flex flex-col gap-3">
      {#if restrictions}
        <div class="flex flex-col gap-1">
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-medium text-white">Generation restrictions</span>
            <a class={LINK_CLASS} href={queueUrl(userId)}>
              {restrictions.status === 'ok' && restrictions.truncated ? 'All in the queue' : 'Restriction queue'}
            </a>
          </div>
          {#if restrictions.status === 'unavailable'}
            <p class="m-0 text-amber-300">Unavailable.</p>
          {:else if restrictions.rows.length === 0}
            <p class="m-0 text-dark-2">No restrictions.</p>
          {:else}
            <ul class="m-0 flex list-none flex-col gap-2 p-0">
              {#each restrictions.rows as r (r.id)}
                <li class="flex min-w-0 flex-col gap-1 break-words">
                  <div>
                    <span class="text-white">{typeLabel(r.type)} #{r.id}</span>
                    · <span class={r.status === 'Pending' ? 'text-amber-300' : ''}>{r.status}</span>
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
                      enabled
                      why=""
                      {ondone}
                    />
                  {/if}
                </li>
              {/each}
            </ul>
            {#if restrictions.truncated}<p class="m-0 text-dark-2">Showing the newest {restrictions.rows.length}.</p>{/if}
          {/if}
        </div>
      {/if}

      {#if blockedPrompts}
        <div class="flex flex-col gap-1">
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-medium text-white">Blocked prompts</span>
            <a class={LINK_CLASS} href={userLookupUrl(userId, 'basic')}>
              {blockedPrompts.status === 'ok' && blockedPrompts.truncated ? 'All in User Lookup' : 'User Lookup'}
            </a>
          </div>
          {#if blockedPrompts.status === 'unavailable'}
            <p class="m-0 text-amber-300">Unavailable.</p>
          {:else if blockedPrompts.rows.length === 0}
            <p class="m-0 text-dark-2">No blocked prompts.</p>
          {:else}
            <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
              {#each blockedPrompts.rows as p (p.key)}
                <li class="min-w-0 break-words">
                  <span class="text-dark-2" title={dateTime(p.time)}>{relativeTime(p.time)} · {p.source}</span>
                  <div class="whitespace-pre-wrap text-white">{p.prompt}</div>
                  {#if p.negativePrompt}<div class="whitespace-pre-wrap text-dark-2">Negative: {p.negativePrompt}</div>{/if}
                </li>
              {/each}
            </ul>
            {#if blockedPrompts.truncated}<p class="m-0 text-dark-2">Showing the newest {blockedPrompts.rows.length}.</p>{/if}
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</TriageCard>

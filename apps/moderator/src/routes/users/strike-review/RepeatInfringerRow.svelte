<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { RepeatInfringerRow } from '$lib/server/repeat-infringer.service';

  let { row, windowMonths }: { row: RepeatInfringerRow; windowMonths: number } = $props();

  const name = $derived(row.username ?? `#${row.userId}`);
  let note = $state('');

  const reviewed = new FormState({
    reload: true,
    onSuccess: () => {
      note = '';
      toast.success(`Recorded the review of ${name}`);
    },
  });
</script>

<article class="flex flex-col gap-3 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="flex flex-col gap-1">
      <a href={userLookupUrl(row.username ?? row.userId)} class="{LINK_CLASS} font-semibold">{name}</a>
      <p class="text-xs text-dark-2">
        Latest removal {dateTime(row.lastEventAt)}{#if row.reviewedAt}
          · last reviewed {dateTime(row.reviewedAt)}{/if}
      </p>
    </div>
    <Badge variant="destructive">
      Repeat infringer: {row.eventCount} copyright removals in {windowMonths} months
    </Badge>
  </div>

  <ul class="flex flex-col gap-1 text-sm">
    {#each row.events as event (event.id)}
      <li class="flex flex-wrap gap-2">
        <span class="text-dark-2">{dateTime(event.createdAt)}</span>
        <span>{event.description}</span>
        {#if event.status === 'Voided'}<Badge variant="outline">voided, not counted</Badge>{/if}
        {#if event.internalNotes}<span class="text-xs text-dark-2">· {event.internalNotes}</span>{/if}
      </li>
    {/each}
  </ul>

  <form
    method="POST"
    action="?/repeatInfringerReviewed"
    use:enhance={reviewed.enhance}
    class="flex flex-col gap-2"
  >
    <input type="hidden" name="userId" value={row.userId} />
    <Textarea
      name="note"
      bind:value={note}
      placeholder="What you decided and why (internal; saved to user notes)"
      maxlength={2000}
      rows={2}
    />
    {#if reviewed.error}<p class="text-sm text-red-300">{reviewed.error}</p>{/if}
    <div>
      <Button type="submit" size="sm" disabled={reviewed.submitting || !note.trim()}>Reviewed</Button>
    </div>
  </form>
</article>

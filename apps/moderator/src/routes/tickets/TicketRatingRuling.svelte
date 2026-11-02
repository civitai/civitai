<script lang="ts">
  import { enhance } from '$app/forms';
  import { ratingReviewLevelLabel } from '@civitai/shared/rating-review';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { disputeOutcome, isLowerOnly } from '$lib/rating-dispute';
  import type { TicketRatingDispute } from '$lib/server/tickets/rating-disputes';

  let {
    ticketId,
    userId,
    dispute,
    ondone,
  }: {
    ticketId: string;
    userId: number;
    dispute: TicketRatingDispute;
    ondone: (what: string, data: Record<string, unknown> | undefined) => void;
  } = $props();

  // Picking a level only opens the confirm step; the form posts from there.
  let chosen = $state<number | null>(null);
  const outcome = $derived(
    chosen === null
      ? null
      : disputeOutcome(
          dispute.entityType,
          { current: dispute.currentLevel, suggested: dispute.suggestedLevel, chosen },
          dispute.entityExists
        )
  );
  const label = (level: number) => ratingReviewLevelLabel(dispute.entityType, level);
  // Must match the resolve action, which refuses to keep the rating the owner sees without a reason.
  // A lower-only type's top option is its live level.
  const needsReason = $derived(
    chosen !== null &&
      dispute.entityExists &&
      (label(chosen) === label(dispute.currentLevel) ||
        (isLowerOnly(dispute.entityType) && chosen === Math.max(...dispute.levelOptions)))
  );

  const form = new FormState({
    onSuccess: (data) => ondone('Rating dispute decided', data),
    onSettled: () => (chosen = null),
    reset: false,
  });
</script>

<form
  method="POST"
  action="?/ratingDisputeResolve"
  use:enhance={form.enhance}
  class="flex flex-col gap-1.5"
>
  <input type="hidden" name="ticketId" value={ticketId} />
  <input type="hidden" name="userId" value={userId} />
  <input type="hidden" name="reviewId" value={dispute.id} />
  {#if chosen === null || !outcome}
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="text-xs text-dark-2">Apply rating</span>
      {#each dispute.levelOptions as level (level)}
        <Button
          type="button"
          size="sm"
          variant={level === dispute.suggestedLevel ? 'default' : 'outline'}
          disabled={form.submitting}
          onclick={() => (chosen = level)}
          data-touch-target
        >
          {label(level)}{level === dispute.suggestedLevel ? ' (owner asks)' : ''}{level === dispute.currentLevel ? ' (current)' : ''}
        </Button>
      {/each}
    </div>
  {:else}
    <input type="hidden" name="appliedLevel" value={chosen} />
    <p class="m-0 text-xs">
      <span class="font-semibold {outcome.approves ? 'text-green-300' : 'text-red-300'}">{outcome.label}</span>
      <span class="text-dark-0">{outcome.effect}</span>
    </p>
    <Textarea
      name="modComment"
      rows={2}
      maxlength={1000}
      required={needsReason}
      placeholder={needsReason
        ? 'Reason for keeping this rating (required, the owner sees this)'
        : 'Note to owner (optional, they see this)'}
      aria-label="Note to owner"
    />
    <div class="flex flex-wrap items-center gap-1.5">
      <Button type="submit" size="sm" disabled={form.submitting} data-touch-target>
        Yes, apply {label(chosen)}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={form.submitting}
        onclick={() => (chosen = null)}
        data-touch-target
      >
        Cancel
      </Button>
    </div>
  {/if}
  {#if form.error}<p class="m-0 text-xs text-red-300">{form.error}</p>{/if}
  {#if form.warning}<p class="m-0 text-xs text-amber-300">{form.warning}</p>{/if}
</form>

<script lang="ts">
  import { allowanceState, windowLabel, type AnnouncementAllowance } from '$lib/announcements';

  let {
    allowance,
    error = null,
  }: { allowance: AnnouncementAllowance | null; error?: string | null } = $props();

  const allowState = $derived(allowance ? allowanceState(allowance) : null);
  const remaining = $derived(allowance ? Math.max(allowance.limit - allowance.used, 0) : 0);
  const nextAvailable = $derived(
    allowance?.nextAvailableAt
      ? new Date(allowance.nextAvailableAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        })
      : null
  );
</script>

<div class="cs-panel p-5">
  {#if error || !allowance}
    <h2 class="text-sm font-semibold text-white">Allowance unavailable</h2>
    <p class="mt-1 text-sm text-dark-2">
      {error ?? 'We could not read your announcement allowance.'} Saving may still work — the limit is
      checked again when you post.
    </p>
  {:else if allowState === 'ineligible'}
    <h2 class="text-sm font-semibold text-white">Announcements aren't unlocked yet</h2>
    <p class="mt-1 text-sm text-dark-2">
      They open at a creator score of {allowance.minScore.toLocaleString()}. Yours is
      {allowance.score.toLocaleString()}. Keep publishing — this isn't a waiting period, it's a
      score.
    </p>
    <p class="mt-2 text-sm text-dark-2">
      You can still pin a profile announcement below: it shows on your profile, notifies nobody, and
      needs no allowance.
    </p>
  {:else if allowState === 'exhausted'}
    <h2 class="text-sm font-semibold text-white">No slots left right now</h2>
    <p class="mt-1 text-sm text-dark-2">
      You've used {allowance.used} of {allowance.limit} for this {windowLabel(allowance.windowDays)}
      {#if nextAvailable}· next slot {nextAvailable}{/if}
    </p>
    <p class="mt-2 text-sm text-dark-2">
      Profile-only announcements don't use a slot, so you can still post one of those.
    </p>
  {:else}
    <h2 class="text-sm font-semibold text-white">
      {remaining} of {allowance.limit} announcements left
    </h2>
    <p class="mt-1 text-sm text-dark-2">
      Your {allowance.tier} allowance is {allowance.limit} per {windowLabel(allowance.windowDays)}.
      Profile-only announcements don't count against it.
    </p>
  {/if}
</div>

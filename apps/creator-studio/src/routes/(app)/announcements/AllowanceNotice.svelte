<script lang="ts">
  import { allowanceState, windowLabel, type AnnouncementAllowance } from '$lib/announcements';

  let { allowance }: { allowance: AnnouncementAllowance | null } = $props();

  const allowState = $derived(allowance ? allowanceState(allowance) : null);
  const nextAvailable = $derived(
    allowance?.nextAvailableAt
      ? new Date(allowance.nextAvailableAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        })
      : null
  );
</script>

<!-- Renders only where it has something to DO: how to become eligible, or what to do with none
     left. The healthy count and a failed read are both on the Broadcasts left card instead, so
     this panel never appears just to restate a number. -->
{#if allowance && allowState !== 'available'}
  <div class="cs-panel p-5">
    {#if allowState === 'ineligible'}
      <h2 class="text-sm font-semibold text-white">Announcements aren't unlocked yet</h2>
      <p class="mt-1 text-sm text-dark-2">
        They open at a creator score of {allowance.minScore.toLocaleString()}. Yours is
        {allowance.score.toLocaleString()}. Keep publishing — this isn't a waiting period, it's a
        score.
      </p>
      <p class="mt-2 text-sm text-dark-2">
        You can still pin an announcement to your profile below: it shows on your profile, notifies
        nobody, and needs no broadcast.
      </p>
    {:else}
      <h2 class="text-sm font-semibold text-white">No broadcasts left right now</h2>
      <p class="mt-1 text-sm text-dark-2">
        You've used {allowance.used} of {allowance.limit} for this {windowLabel(
          allowance.windowDays
        )}
        {#if nextAvailable}· next one {nextAvailable}{/if}
      </p>
      <p class="mt-2 text-sm text-dark-2">
        An announcement you don't broadcast uses none of these, so you can still post one of those.
      </p>
    {/if}
  </div>
{/if}

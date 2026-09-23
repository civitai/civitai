<script lang="ts">
  import { IconBellRinging, IconBellOff, IconSend } from '@tabler/icons-svelte';
  import StatCard from '$lib/components/StatCard.svelte';
  import { allowanceState, type AnnouncementAllowance } from '$lib/announcements';
  import type { AnnouncementMetrics } from '$lib/server/announcement-analytics';

  let {
    metrics,
    allowance,
    allowanceError = null,
  }: {
    metrics: AnnouncementMetrics | null;
    allowance: AnnouncementAllowance | null;
    allowanceError?: string | null;
  } = $props();

  const num = (n: number) => n.toLocaleString();

  // Followers minus mutes: the number of people a non-profile-only announcement can actually
  // reach. Clamped, because the two figures come from different tables and a follower count that
  // is momentarily behind should read as zero rather than as a negative audience.
  const reach = $derived(metrics ? Math.max(metrics.followers - metrics.mutedNow, 0) : 0);

  const broadcastsLeft = $derived(allowance ? Math.max(allowance.limit - allowance.used, 0) : 0);
  // 🔴 Eligibility is separate from the count. `getAnnouncementAllowance` returns `used: 0` and the
  // free-tier `limit: 1` even to a creator below the score floor, so rendering the subtraction
  // unguarded tells someone who cannot broadcast at all that they have one left — directly above a
  // notice saying the feature is not unlocked and a Save button that is disabled.
  const hasCount = $derived(
    !!allowance && !allowanceError && allowanceState(allowance) !== 'ineligible'
  );
</script>

<div class="grid gap-3 sm:grid-cols-3">
  <StatCard label="Receiving your announcements" icon={IconBellRinging}>
    <p class="mt-1 text-xl font-semibold text-white">{metrics ? num(reach) : '—'}</p>
  </StatCard>

  <StatCard label="Muted your announcements" icon={IconBellOff}>
    <p class="mt-1 text-xl font-semibold text-white">{metrics ? num(metrics.mutedNow) : '—'}</p>
  </StatCard>

  <StatCard label="Broadcasts left" icon={IconSend}>
    <p class="mt-1 text-xl font-semibold text-white">
      {hasCount ? num(broadcastsLeft) : '—'}
    </p>
    {#if !allowance || allowanceError}
      <!-- The ONLY subtext on these cards, and it earns its place: a dash alone cannot say whether
           the answer is zero, not applicable, or unavailable, and this one is unavailable. -->
      <p class="mt-1 text-xs text-dark-2">Couldn't load — posting still checks the limit</p>
    {/if}
  </StatCard>
</div>

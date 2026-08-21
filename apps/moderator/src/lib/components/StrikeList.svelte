<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { dateTime, type Jsonified } from '$lib/format';
  import type { LiveStrike } from '$lib/server/user-lookup.service';

  let {
    strikes,
    empty = 'No strikes on this account.',
  }: { strikes: LiveStrike[] | Jsonified<LiveStrike>[]; empty?: string } = $props();

  // `getActiveStrikes` says the same thing in SQL — a new status value has to be taught to both.
  const spent = (s: LiveStrike | Jsonified<LiveStrike>) =>
    s.voidedAt != null || s.status !== 'Active' || new Date(s.expiresAt).getTime() < Date.now();
</script>

{#if strikes.length === 0}
  <p class="text-sm text-dark-2">{empty}</p>
{:else}
  <ul class="space-y-1 text-sm">
    {#each strikes as s (s.id)}
      {@const isSpent = spent(s)}
      {@const lapsed = new Date(s.expiresAt).getTime() < Date.now()}
      <li class="flex flex-wrap items-baseline gap-x-2">
        <!-- A voided or lapsed strike still counts as history but not as rope, so it must not read
             the same as one holding the account at its limit. -->
        <Badge variant={isSpent ? 'outline' : 'destructive'}>
          {s.voidedAt != null ? 'voided' : lapsed ? 'expired' : s.reason}
        </Badge>
        <span class="text-dark-0">{s.description}</span>
        <span class="text-xs text-dark-2">
          {s.points} point{s.points === 1 ? '' : 's'} · {dateTime(s.createdAt)}
          {#if !isSpent}· until {dateTime(s.expiresAt)}{/if}
        </span>
      </li>
    {/each}
  </ul>
{/if}

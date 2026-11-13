<script lang="ts">
  import { num } from '$lib/format';
  import StrikeReviewRow from './StrikeReviewRow.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<header class="page-header">
  <h1>Strike review</h1>
  <p>
    Accounts the strike system has muted indefinitely and flagged for a moderator's decision, oldest
    flag first. Strikes never ban on their own: ban the account, unmute it, or void strikes that should
    not stand. An account leaves this list when it is banned, unmuted, or its active points fall below
    the review tier.
  </p>
  <p class="mt-1 text-xs text-dark-2">
    {num(data.total)} account{data.total === 1 ? '' : 's'} waiting{data.total > data.rows.length
      ? `, showing the oldest ${num(data.rows.length)}`
      : ''}.
  </p>
</header>

{#if data.rows.length === 0}
  <p class="text-sm text-dark-2">No accounts are waiting for strike review.</p>
{:else}
  <div class="flex flex-col gap-3">
    {#each data.rows as row (row.userId)}
      <StrikeReviewRow
        {row}
        civitaiUrl={data.civitaiUrl}
        canBan={!!data.grants['audit.ban.execute']}
      />
    {/each}
  </div>
{/if}

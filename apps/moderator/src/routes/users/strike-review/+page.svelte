<script lang="ts">
  import { num } from '$lib/format';
  import RepeatInfringerRow from './RepeatInfringerRow.svelte';
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

<section class="mt-8 flex flex-col gap-3">
  <header>
    <h2 class="text-lg font-semibold">Repeat infringers</h2>
    <p class="text-sm text-dark-2">
      Accounts with {data.repeatInfringerPolicy.threshold} or more copyright removals in the last
      {data.repeatInfringerPolicy.windowMonths} months (voided strikes do not count). Ban from the
      account page if that is the decision; either way, mark it reviewed with a note. A new removal
      after the review brings the account back.
    </p>
    {#if data.repeatInfringers}
      <p class="mt-1 text-xs text-dark-2">
        {num(data.repeatInfringers.total)} account{data.repeatInfringers.total === 1 ? '' : 's'} waiting.
      </p>
    {/if}
  </header>
  {#if !data.repeatInfringers}
    <p class="text-sm text-red-300">The repeat-infringer queue could not be loaded. Reload to retry.</p>
  {:else if data.repeatInfringers.rows.length === 0}
    <p class="text-sm text-dark-2">No accounts are waiting for repeat-infringer review.</p>
  {:else}
    {#each data.repeatInfringers.rows as row (row.userId)}
      <RepeatInfringerRow {row} windowMonths={data.repeatInfringerPolicy.windowMonths} />
    {/each}
  {/if}
</section>

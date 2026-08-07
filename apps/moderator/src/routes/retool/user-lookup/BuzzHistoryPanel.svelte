<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from './format';
  import { fetchBuzzHistory } from './buzz-history';

  let { userId }: { userId: number } = $props();

  const SHOWN = 10;
  let expanded = $state(false);

  // Its own fetch rather than riding the account payload: ~800ms against a 1.5B-row table.
  const history = $derived(browser ? fetchBuzzHistory(userId) : null);

  const COLOR_CLASS: Record<string, string> = {
    Yellow: 'text-yellow-400',
    Blue: 'text-blue-4',
    Green: 'text-green-400',
  };
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Buzz history</h3>
  <!-- Above the await deliberately: the window is what stops an empty list reading as "never moved
       Buzz", so it has to survive the loading and error states too. -->
  <p class="mb-3 text-xs text-dark-2">
    Transfers in and out over the last 90 days — always bounded, never the full history.
  </p>

  {#await history}
    <p class="text-sm text-dark-2">Loading Buzz movement…</p>
  {:then result}
    {#if !result}
      <p class="text-sm text-dark-2">Loading Buzz movement…</p>
    {:else}
      {#if result.truncated}
        <p class="mb-2 text-xs text-amber-300">
          More than {num(result.transactions.length)} in that window — only the most recent are shown.
        </p>
      {/if}

      {#if result.transactions.length === 0}
        <p class="text-sm text-dark-2">No Buzz movement in this window.</p>
      {:else}
        <ul class="space-y-1 text-sm">
          {#each expanded ? result.transactions : result.transactions.slice(0, SHOWN) as t (t.transactionId)}
            <li class="flex flex-wrap items-baseline gap-x-2">
              <span
                class="tabular-nums {t.direction === 'in' ? 'text-green-400' : 'text-dark-0'}"
                title={t.direction === 'in' ? 'received' : 'sent'}
              >
                {t.direction === 'in' ? '+' : '−'}{num(Math.abs(t.amount))}
              </span>
              <span class="text-xs {COLOR_CLASS[t.color] ?? 'text-dark-2'}">{t.color}</span>
              <Badge variant="secondary">{t.type}</Badge>
              {#if t.counterpartyName}
                <a href="?q={t.counterpartyId}" class={LINK_CLASS}>{t.counterpartyName}</a>
              {:else}
                <span class="text-xs text-dark-2">{t.counterpartyLabel ?? `account ${t.counterpartyId}`}</span>
              {/if}
              <span class="text-xs text-dark-2">{dateTime(t.date)}</span>
              {#if t.description}
                <span class="truncate text-xs text-dark-2">{t.description}</span>
              {/if}
            </li>
          {/each}
        </ul>
        {#if result.transactions.length > SHOWN}
          <button
            type="button"
            class="mt-3 text-sm {LINK_CLASS}"
            onclick={() => (expanded = !expanded)}
          >
            {expanded ? 'Show less' : `Show all ${result.transactions.length}`}
          </button>
        {/if}
      {/if}
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load Buzz history.</p>
  {/await}
</section>

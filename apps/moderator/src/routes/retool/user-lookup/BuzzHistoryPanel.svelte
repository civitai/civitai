<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { fetchBuzzHistory, filterTransactions, typesIn, type BuzzTransaction } from './buzz-history';

  let { userId }: { userId: number } = $props();

  // Retool's `After date` picker, as a window. Bounded because the table is 1.5B rows.
  const WINDOWS = [7, 30, 90, 180, 365];
  let days = $state('90');

  // Its own fetch rather than riding the account payload: ~800ms against a 1.5B-row table. Re-derives
  // when the window changes, so there is no state to go stale.
  const history = $derived(browser ? fetchBuzzHistory(userId, Number(days)) : null);

  let paymentType = $state('all');
  let receiptType = $state('all');
  let paymentSearch = $state('');
  let receiptSearch = $state('');

  const COLOR_CLASS: Record<string, string> = {
    Yellow: 'text-yellow-400',
    Blue: 'text-blue-4',
    Green: 'text-green-400',
  };
</script>

{#snippet table(
  title: string,
  rows: BuzzTransaction[],
  all: BuzzTransaction[],
  type: string,
  search: string,
  onType: (v: string) => void,
  onSearch: (v: string) => void
)}
  <div class="min-w-0 flex-1">
    <h4 class="mb-2 text-sm font-semibold text-white">
      {title}
      <span class="font-normal text-dark-2">({num(rows.length)})</span>
    </h4>

    <div class="mb-2 flex flex-wrap gap-2">
      <Select.Root type="single" value={type} onValueChange={onType}>
        <Select.Trigger class="w-44">{type === 'all' ? 'All types' : type}</Select.Trigger>
        <Select.Content>
          <Select.Item value="all">All types</Select.Item>
          {#each typesIn(all) as t (t)}
            <Select.Item value={t}>{t}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <Input
        value={search}
        oninput={(e) => onSearch(e.currentTarget.value)}
        placeholder="Description contains"
        class="min-w-40 flex-1"
      />
    </div>

    {#if rows.length === 0}
      <p class="text-sm text-dark-2">
        {all.length ? 'Nothing matches those filters.' : 'None in this window.'}
      </p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each rows as t (t.transactionId)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <span class="tabular-nums {t.direction === 'in' ? 'text-green-400' : 'text-dark-0'}">
              {t.direction === 'in' ? '+' : '−'}{num(Math.abs(t.amount))}
            </span>
            <span class="text-xs {COLOR_CLASS[t.color] ?? 'text-dark-2'}">{t.color}</span>
            <Badge variant="secondary">{t.type}</Badge>
            {#if t.counterpartyName}
              <a href="?q={t.counterpartyId}" class={LINK_CLASS}>{t.counterpartyName}</a>
            {:else}
              <span class="text-xs text-dark-2">
                {t.counterpartyLabel ?? `account ${t.counterpartyId}`}
              </span>
            {/if}
            <span class="text-xs text-dark-2">{dateTime(t.date)}</span>
            {#if t.description}
              <span class="truncate text-xs text-dark-2" title={t.description}>{t.description}</span>
            {/if}
            {#if t.externalTransactionId}
              <span class="text-xs text-dark-3" title="External transaction id">
                {t.externalTransactionId}
              </span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/snippet}

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
    <div>
      <h3 class="text-sm font-semibold text-white">Buzz movement</h3>
      <!-- Above the await deliberately: the window is what stops an empty list reading as "never moved
           Buzz", so it has to survive the loading and error states too. -->
      <p class="text-xs text-dark-2">
        Payments are Buzz leaving this account, receipts Buzz arriving — always bounded, never the full
        history.
      </p>
    </div>
    <label class="flex items-center gap-2 text-xs text-dark-2">
      Window
      <Select.Root type="single" bind:value={days}>
        <Select.Trigger class="w-28">{days} days</Select.Trigger>
        <Select.Content>
          {#each WINDOWS as w (w)}
            <Select.Item value={String(w)}>{w} days</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </label>
  </div>

  {#await history}
    <p class="text-sm text-dark-2">Loading Buzz movement…</p>
  {:then result}
    {#if !result}
      <p class="text-sm text-dark-2">Loading Buzz movement…</p>
    {:else}
      {#if result.truncated}
        <p class="mb-2 text-xs text-amber-300">
          More than {num(result.payments.length + result.receipts.length)} in that window — only the most
          recent are shown. Narrow the window to see further back within the cap.
        </p>
      {/if}

      <div class="flex flex-col gap-6 lg:flex-row">
        {@render table(
          'Payments',
          filterTransactions(result.payments, paymentType, paymentSearch),
          result.payments,
          paymentType,
          paymentSearch,
          (v) => (paymentType = v),
          (v) => (paymentSearch = v)
        )}
        {@render table(
          'Receipts',
          filterTransactions(result.receipts, receiptType, receiptSearch),
          result.receipts,
          receiptType,
          receiptSearch,
          (v) => (receiptType = v),
          (v) => (receiptSearch = v)
        )}
      </div>
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load Buzz history.</p>
  {/await}
</section>

<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import ShowMoreButton from '$lib/components/ShowMoreButton.svelte';
  import { keepLast } from '$lib/keep-last.svelte';
  import {
    fetchBuzzLedgerSide,
    fetchBuzzLedgerTypes,
    filterTransactions,
    type BuzzTransaction,
    type BuzzLedgerSide,
  } from './buzz-history';

  let { userId }: { userId: number } = $props();

  // The counterparty lists rendered ten and headed themselves with the full count, so a moderator
  // looking for who an account farmed Buzz with saw "(47)" over ten rows and nothing saying so.
  const TOTALS_SHOWN = 10;
  let paymentTotalsOpen = $state(false);
  let receiptTotalsOpen = $state(false);

  // Retool's `After date` picker, as a window. Bounded because the table is 1.5B rows.
  const WINDOWS = [7, 30, 90, 180, 365];
  let days = $state('90');

  const LIMIT_STEP = 200;
  const LIMIT_MAX = 2000;

  // Per side, all of it. The columns filter and page independently, so sharing any of this state made
  // each of them refetch — and blank — the other for an answer that had not changed.
  let paymentLimit = $state(LIMIT_STEP);
  let receiptLimit = $state(LIMIT_STEP);
  let paymentType = $state('all');
  let receiptType = $state('all');
  let paymentSearch = $state('');
  let receiptSearch = $state('');

  // Its own fetch rather than riding the account payload: ~800ms against a 1.5B-row table. The TYPE
  // filter is part of the REQUEST, not applied to its result — selecting one re-queries that side for
  // rows of that type, which is the only way past a cap a busy account fills in two days. The
  // description search stays client-side: `description` has no index on a 1.5B-row table.
  //
  // `days` is the one control that is deliberately shared — it reframes the question for both columns.
  // `keepLast`, not `{#await}`: paging or re-filtering must not replace rows already on screen with a
  // spinner. See its own file for why this is the one place that shape is allowed.
  const payments = keepLast(() =>
    browser ? fetchBuzzLedgerSide(userId, 'payments', Number(days), paymentLimit, paymentType) : null
  );
  const receipts = keepLast(() =>
    browser ? fetchBuzzLedgerSide(userId, 'receipts', Number(days), receiptLimit, receiptType) : null
  );

  // Depends on the window alone — not the cap, not the selected type — so choosing a filter never
  // reloads the list of filters, and the control keeps working while the rows it governs are in flight.
  const ledgerTypes = keepLast(() => (browser ? fetchBuzzLedgerTypes(userId, Number(days)) : null));

  // Retool's second row: counterparty x total, per side. The transaction list answers "what happened";
  // this answers "who with, and how much in total" — which is the farming question, and the one a
  // 200-row list of individual movements actively hides.
  //
  // Aggregated over the SAME filtered rows the table above shows, so the totals always agree with what
  // is on screen rather than silently summing a different set.
  type Aggregate = { id: number; name: string | null; label: string | null; total: number; n: number };
  const aggregate = (rows: BuzzTransaction[]): Aggregate[] => {
    const by = new Map<number, Aggregate>();
    for (const t of rows) {
      const cur = by.get(t.counterpartyId) ?? {
        id: t.counterpartyId,
        name: t.counterpartyName,
        label: t.counterpartyLabel,
        total: 0,
        n: 0,
      };
      cur.total += t.amount;
      cur.n += 1;
      by.set(t.counterpartyId, cur);
    }
    return [...by.values()].sort((a, b) => b.total - a.total);
  };

  const COLOR_CLASS: Record<string, string> = {
    Yellow: 'text-yellow-400',
    Blue: 'text-blue-4',
    Green: 'text-green-400',
  };
</script>

{#snippet totals(
  title: string,
  rows: BuzzTransaction[],
  expanded: boolean,
  onToggle: () => void,
  capped: boolean
)}
  {@const agg = aggregate(rows)}
  <div class="min-w-0 flex-1">
    <h4 class="mb-2 text-sm font-semibold text-white">
      {title}
      <span class="font-normal text-dark-2">({num(agg.length)})</span>
    </h4>
    {#if rows.length === 0}
      <p class="text-sm text-dark-2">Nothing in this window.</p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each expanded ? agg : agg.slice(0, TOTALS_SHOWN) as a (a.id)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <span class="tabular-nums text-dark-0">{num(a.total)}</span>
            {#if a.name}
              <a href="?q={a.id}" class={LINK_CLASS}>{a.name}</a>
            {:else}
              <span class="text-dark-2">{a.label ?? `account ${a.id}`}</span>
            {/if}
            <span class="text-xs text-dark-2">
              across {a.n} transaction{a.n === 1 ? '' : 's'}
            </span>
          </li>
        {/each}
      </ul>
      <ShowMoreButton total={agg.length} shown={TOTALS_SHOWN} {expanded} {capped} {onToggle} />
    {/if}
  </div>
{/snippet}

{#snippet controls(
  type: string,
  search: string,
  /** Every type this side HAS, from the server — not the types on this page, which is what the cap
   *  left behind. Selecting one is what fetches it. */
  offeredTypes: string[],
  onType: (v: string) => void,
  onSearch: (v: string) => void
)}
  <div class="mb-2 flex flex-wrap gap-2">
    <Select.Root type="single" value={type} onValueChange={onType}>
      <Select.Trigger class="w-44">{type === 'all' ? 'All types' : type}</Select.Trigger>
      <Select.Content>
        <Select.Item value="all">All types</Select.Item>
        {#each offeredTypes as t (t)}
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
{/snippet}

{#snippet column(
  title: string,
  side: ReturnType<typeof keepLast<BuzzLedgerSide>>,
  offeredTypes: string[],
  type: string,
  search: string,
  onType: (v: string) => void,
  onSearch: (v: string) => void,
  onLoadMore: (() => void) | null
)}
  <h4 class="mb-2 flex items-baseline gap-2 text-sm font-semibold text-white">
    {title}
    {#if side.value}
      <span class="font-normal text-dark-2">
        ({num(filterTransactions(side.value.rows, search).length)}{side.value.truncated ? '+' : ''})
      </span>
    {/if}
    <!-- Beside the heading rather than in place of the rows: this says a request is in flight without
         taking away what is already on screen. -->
    {#if side.loading}<span class="text-xs font-normal text-dark-2">updating…</span>{/if}
  </h4>

  {@render controls(type, search, offeredTypes, onType, onSearch)}

  {#if side.failed}
    <p class="mb-2 text-sm text-red-300">
      Could not load {title.toLowerCase()}.{side.value ? ' Showing the last result that loaded.' : ''}
    </p>
  {/if}

  {#if side.value}
    {@render rows(
      filterTransactions(side.value.rows, search),
      type,
      search,
      side.value.truncated,
      side.value.limit,
      onLoadMore
    )}
  {:else if side.loading}
    <p class="text-sm text-dark-2">Loading {title.toLowerCase()}…</p>
  {/if}
{/snippet}

{#snippet rows(
  list: BuzzTransaction[],
  type: string,
  search: string,
  capped: boolean,
  /** The cap the SERVER applied, which is clamped — the local request value can exceed it. */
  appliedLimit: number,
  onLoadMore: (() => void) | null
)}
  {#if capped}
    <p class="mb-2 text-xs text-amber-300">
      Only the newest {num(appliedLimit)} are shown — this side has more, and the oldest were dropped.
      {#if onLoadMore}
        <button type="button" class="underline" onclick={onLoadMore}>
          Load {num(LIMIT_STEP)} more
        </button>
      {:else}
        Narrow the window to see further back.
      {/if}
    </p>
  {/if}

  {#if list.length === 0}
    <p class="text-sm text-dark-2">
      {#if search.trim()}
        Nothing on this page matches that description.
      {:else if type !== 'all'}
        No <strong>{type}</strong> on this side in this window.
      {:else}
        None in this window.
      {/if}
    </p>
  {:else}
    <ul class="space-y-1 text-sm">
      {#each list as t (t.transactionId)}
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
            <span class="text-xs text-dark-2" title="External transaction id">
              {t.externalTransactionId}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
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

  <!-- Nothing here is behind a pending branch. The heading and the controls always render, and the rows
       that are already loaded stay on screen while the next page or filter is in flight — a moderator
       who picked the wrong type, or is waiting on a slow side, must be able to act without the first
       query finishing, and must not lose data they were reading to do it. -->
  <div class="flex flex-col gap-6 lg:flex-row">
    <div class="min-w-0 flex-1">
      {@render column(
        'Payments',
        payments,
        ledgerTypes.value?.payments ?? [],
        paymentType,
        paymentSearch,
        (v) => (paymentType = v),
        (v) => (paymentSearch = v),
        paymentLimit < LIMIT_MAX
          ? () => (paymentLimit = Math.min(paymentLimit + LIMIT_STEP, LIMIT_MAX))
          : null
      )}
    </div>
    <div class="min-w-0 flex-1">
      {@render column(
        'Receipts',
        receipts,
        ledgerTypes.value?.receipts ?? [],
        receiptType,
        receiptSearch,
        (v) => (receiptType = v),
        (v) => (receiptSearch = v),
        receiptLimit < LIMIT_MAX
          ? () => (receiptLimit = Math.min(receiptLimit + LIMIT_STEP, LIMIT_MAX))
          : null
      )}
    </div>
  </div>

  <div class="mt-6 flex flex-col gap-6 border-t border-dark-4 pt-4 lg:flex-row">
    {@render totals(
      'Paid to, by counterparty',
      filterTransactions(payments.value?.rows ?? [], paymentSearch),
      paymentTotalsOpen,
      () => (paymentTotalsOpen = !paymentTotalsOpen),
      payments.value?.truncated ?? false
    )}
    {@render totals(
      'Received from, by counterparty',
      filterTransactions(receipts.value?.rows ?? [], receiptSearch),
      receiptTotalsOpen,
      () => (receiptTotalsOpen = !receiptTotalsOpen),
      receipts.value?.truncated ?? false
    )}
  </div>
</section>

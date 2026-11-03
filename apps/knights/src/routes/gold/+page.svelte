<script lang="ts">
  import { enhance } from '$app/forms';
  import type { ComponentProps } from 'svelte';
  import { count } from '$lib/format';
  import Icon from '$lib/Icon.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  const balance = $derived(data.balance);
  const canConvert = $derived(data.conversionOpen && balance.buzzOnConvert > 0);
  let converting = $state(false);

  const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const STATUS = {
    pending: { label: 'On its way', tone: 'open' },
    paid: { label: 'Paid', tone: 'paid' },
    failed: { label: 'Failed', tone: 'failed' },
  } as const;
  const statusOf = (status: string) =>
    status in STATUS ? STATUS[status as keyof typeof STATUS] : { label: status, tone: '' };

  type Row = { icon: ComponentProps<typeof Icon>['name']; title: string; note: string; value: number; tone: string };
  const rows = $derived.by(() => {
    const list: Row[] = [
      { icon: 'coins', title: 'Convertible', note: 'Earned; yours to convert', value: balance.convertible, tone: 'gold' },
      {
        icon: 'hourglass',
        title: 'Pending',
        note: 'From judgments not yet settled; a wrong one earns nothing',
        value: balance.pending,
        tone: '',
      },
    ];
    if (balance.held) {
      list.push({ icon: 'snowflake', title: 'Frozen', note: 'Kept safe while your account is under review', value: balance.frozen, tone: 'frozen' });
    }
    if (balance.onItsWay > 0) {
      list.push({ icon: 'send', title: 'On its way', note: 'A conversion Buzz has not confirmed yet; it is paid once', value: balance.onItsWay, tone: '' });
    }
    list.push({ icon: 'circle-check', title: 'Converted so far', note: 'Paid to you as Yellow Buzz', value: balance.converted, tone: 'paid' });
    return list;
  });
</script>

<div class="page-wide gold">
  <div class="ledger">
    <p class="eyebrow">Your ledger</p>
    <h1 class="page-title">Gold</h1>
    <p class="lede">
      Earned gold becomes Yellow Buzz. Pending gold settles when each image is decided.
    </p>

    <ul class="rows">
      {#each rows as row (row.title)}
        <li class="row {row.tone}">
          <Icon name={row.icon} size={22} />
          <span class="text">
            <span class="title">{row.title}</span>
            <span class="note">{row.note}</span>
          </span>
          <span class="value">{count(row.value)}</span>
        </li>
      {/each}
    </ul>
  </div>

  <aside class="side" class:held={balance.held}>
    {#if balance.held}
      <p class="eyebrow crimson">Payout held</p>
      <h2 class="side-title">Your gold is frozen.</h2>
      <p class="muted">
        You cannot convert gold while the review lasts. Nothing is lost, and judging still earns XP.
      </p>
    {:else}
      <p class="eyebrow">Convert</p>
      <p class="buzz"><span class="amount">{count(balance.buzzOnConvert)}</span> <span class="unit label-caps">Buzz</span></p>
      {#if canConvert}
        <p class="muted from">
          From {count(balance.buzzOnConvert * balance.goldPerBuzz)} of your {count(balance.convertible)} convertible
          gold. The rest stays in your ledger.
        </p>
      {/if}
      <p class="muted from">
        {count(balance.goldPerBuzz)} gold is 1 Yellow Buzz, converted in whole Buzz, at least {balance.minBuzz} at a time.
      </p>
    {/if}

    {#if !data.conversionOpen}
      <p class="muted">Converting gold to Buzz isn't open yet. Your gold keeps accruing.</p>
    {/if}

    <form
      method="POST"
      action="?/convert"
      use:enhance={() => {
        converting = true;
        return async ({ update }) => {
          try {
            await update();
          } finally {
            converting = false;
          }
        };
      }}
    >
      <button type="submit" class="btn primary block" disabled={!canConvert || converting}>
        {#if converting}
          Converting…
        {:else if canConvert}
          Convert to {balance.buzzOnConvert} Buzz
        {:else}
          Convert
        {/if}
      </button>
    </form>
    {#if form?.message}
      {#if form.ok}
        <p role="status" class="ok">{form.message}</p>
      {:else}
        <p role="alert" class="problem">{form.message}</p>
      {/if}
    {/if}
  </aside>

  <section class="recent" aria-labelledby="recent-title">
    <h2 id="recent-title" class="eyebrow muted-eyebrow">Recent conversions</h2>
    {#if data.recent.length === 0}
      <p class="muted empty">No conversions yet. Your first one will show here.</p>
    {:else}
      <ul class="recent-list">
        {#each data.recent as c (c.id)}
          {@const s = statusOf(c.status)}
          <li class="recent-row">
            <time class="when" datetime={c.at}>{c.today ? 'Today' : dayFormat.format(new Date(c.at))}</time>
            <span class="what">{count(c.gold)} gold → {count(c.buzz)} Buzz</span>
            <span class="state {s.tone}">{s.label}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  p {
    margin: 0;
  }
  .gold {
    display: grid;
    grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
    grid-template-areas:
      'ledger side'
      'ledger recent';
    grid-template-rows: auto 1fr;
    column-gap: 3rem;
    row-gap: 2rem;
    align-items: start;
  }
  .ledger {
    grid-area: ledger;
  }
  .side {
    grid-area: side;
  }
  .recent {
    grid-area: recent;
  }
  .muted-eyebrow {
    margin: 0 0 0.5rem;
    color: var(--io-parchment-muted);
  }
  .recent-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .recent-row {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    padding: 0.7rem 0;
    border-bottom: 1px solid var(--io-gold-muted);
  }
  .when {
    flex: 0 0 4.5rem;
    color: var(--io-parchment-muted);
    font: 400 0.9rem/1.3 var(--io-font-ui);
  }
  .what {
    flex: 1;
    min-width: 0;
    color: var(--io-parchment);
    font: 400 1.2rem/1.3 var(--io-font-body);
  }
  .state {
    flex: none;
    white-space: nowrap;
    font: 600 0.85rem/1.3 var(--io-font-ui);
    color: var(--io-parchment-muted);
  }
  .state.open {
    color: var(--io-gold);
  }
  .state.paid {
    color: var(--io-verdigris);
  }
  .state.failed {
    color: var(--io-crimson-text);
  }
  .empty {
    font: 400 0.95rem/1.45 var(--io-font-ui);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem 0.25rem;
    color: var(--io-parchment-muted);
  }
  .row .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }
  .title {
    color: var(--io-parchment);
    font: 500 1.05rem/1.3 var(--io-font-ui);
  }
  .note {
    font: 400 0.9rem/1.35 var(--io-font-ui);
  }
  .value {
    color: var(--io-parchment);
    font: 700 1.75rem/1 var(--io-font-display);
  }
  .row.gold .value,
  .row.gold {
    color: var(--io-gold);
  }
  .row.paid,
  .row.paid .value {
    color: var(--io-verdigris);
  }
  .row.frozen,
  .row.frozen .value {
    color: var(--io-crimson-text);
  }
  .row.gold .title,
  .row.paid .title,
  .row.frozen .title {
    color: var(--io-parchment);
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.75rem;
    border: 1.5px solid var(--io-gold);
    border-radius: 8px;
    background: var(--io-surface);
  }
  .side.held {
    border-color: var(--io-crimson);
  }
  .side-title {
    margin: 0;
    color: var(--io-parchment);
    font-size: 1.6rem;
    text-transform: uppercase;
  }
  .buzz {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }
  .amount {
    color: var(--io-gold);
    font: 700 4rem/1 var(--io-font-display);
  }
  .unit {
    color: var(--io-parchment);
    font-size: 1.1rem;
  }
  .from {
    font: 400 0.95rem/1.45 var(--io-font-ui);
  }
  .ok {
    color: var(--io-gold);
  }
  .problem {
    color: var(--io-crimson-text);
    font-weight: bold;
  }
  @media (max-width: 47.99rem) {
    .gold {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: 'side' 'ledger' 'recent';
      grid-template-rows: auto;
      row-gap: 1.5rem;
    }
    .amount {
      font-size: 3rem;
    }
    .value {
      font-size: 1.4rem;
    }
  }
</style>

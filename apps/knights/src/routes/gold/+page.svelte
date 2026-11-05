<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { count, formatClock, formatWait } from '$lib/format';
  import Icon from '$lib/Icon.svelte';
  import PageNav from '$lib/PageNav.svelte';
  import { reducedMotion, tween } from '$lib/motion';
  import PurchaseDialog from './PurchaseDialog.svelte';
  import ShopCard from './ShopCard.svelte';
  import type { PageData } from './$types';

  type Card = NonNullable<PageData['shop']>['cards'][number];

  let { data }: { data: PageData } = $props();
  const balance = $derived(data.balance);
  const cards = $derived(data.shop?.cards ?? []);
  const deals = $derived(cards.filter((card) => card.deal));
  const rest = $derived(cards.filter((card) => !card.deal));
  const packs = $derived(rest.filter((card) => card.kind === 'buzz_pack'));
  const memberships = $derived(rest.filter((card) => card.kind === 'membership'));
  const cosmetics = $derived(rest.filter((card) => card.kind === 'cosmetic'));

  // The clock follows the server's, so a skewed device still counts down to the real UTC midnight.
  const skew = untrack(() => Date.parse(data.now) - Date.now());
  let nowMs = $state(untrack(() => Date.parse(data.now)));
  const msLeft = $derived(data.shop ? Date.parse(data.shop.refreshesAt) - nowMs : 0);

  // The purse shows what the server last confirmed; a purchase counts it down, never before.
  let shown = $state(untrack(() => data.balance.convertible));
  let floater = $state<{ amount: number; key: number } | null>(null);
  let stamped = $state<string | null>(null);
  let skipped = $state(false);
  let confirming = $state<Card | null>(null);
  let requestKey = $state('');
  let short = $state<{ id: string; key: number; by: number } | null>(null);
  let notice = $state<string | null>(null);
  let noticePending = $state(false);

  onMount(() => {
    const timer = setInterval(() => {
      nowMs = Date.now() + skew;
      if (data.shop && Date.parse(data.shop.refreshesAt) - nowMs <= 0) void invalidateAll();
    }, 1000);
    return () => clearInterval(timer);
  });

  function openConfirm(card: Card) {
    notice = null;
    if (balance.held) return;
    if (balance.convertible < card.price) {
      short = { id: card.id, key: (short?.key ?? 0) + 1, by: card.price - balance.convertible };
      return;
    }
    short = null;
    requestKey = crypto.randomUUID();
    confirming = card;
  }

  function sequence(card: Card, pending: boolean) {
    confirming = null;
    const from = shown;
    const to = balance.convertible;
    stamped = card.id;
    noticePending = pending;
    notice = pending
      ? 'Your gold is reserved. Civitai has not confirmed it yet; we retry automatically and never charge twice.'
      : card.kind === 'cosmetic'
      ? `${card.name} is yours. Equip it from your inventory.`
      : card.kind === 'membership'
      ? 'Membership time added to your Civitai account.'
      : `${count(card.buzz ?? 0)} Buzz sent to your Civitai wallet.`;
    if (!reducedMotion() && from !== to) floater = { amount: from - to, key: Date.now() };
    skipped = false;
    const cancel = tween(from, to, 360, (value) => (shown = Math.round(value)));
    const events = ['pointerdown', 'keydown'] as const;
    const finish = () => {
      for (const event of events) window.removeEventListener(event, skip, true);
      clearTimeout(timer);
      floater = null;
    };
    // Any click or key press jumps to the end state: the count lands, the stamp and the floater go.
    function skip() {
      cancel();
      shown = to;
      skipped = true;
      finish();
    }
    const timer = setTimeout(finish, 720);
    for (const event of events) window.addEventListener(event, skip, true);
  }

  const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const STATUS = {
    pending: { label: 'On its way', tone: 'open' },
    granted: { label: 'Delivered', tone: 'paid' },
    failed: { label: 'Refunded', tone: 'failed' },
  } as const;
  const statusOf = (status: string) =>
    status in STATUS ? STATUS[status as keyof typeof STATUS] : { label: status, tone: '' };
</script>

<div class="page-wide shop" data-skipped={skipped ? '' : undefined}>
  <PageNav />

  <header class="head">
    <div class="intro">
      <p class="eyebrow">The Armory</p>
      <h1 class="page-title">Shop</h1>
      <p class="lede">
        Spend the gold your judgments earn on Buzz, membership and cosmetics that only Knights can wear.
      </p>
    </div>
    <div class="purse" aria-label="Your gold">
      <div class="figure">
        <p class="label">Spendable gold</p>
        <p class="value" aria-live="polite">
          <Icon name="coins" size={26} /><span>{count(shown)}</span>
          {#key floater?.key}
            {#if floater}<span class="floater" aria-hidden="true">−{count(floater.amount)}</span>{/if}
          {/key}
        </p>
      </div>
      <div class="figure">
        <p class="label">Pending</p>
        <p class="value small">{count(balance.pending)}</p>
      </div>
      <a class="inv" href="/gold/inventory" data-sveltekit-preload-data="hover"><Icon name="store" size={16} />Inventory</a>
    </div>
  </header>

  {#if !data.shopOpen}
    <p class="closed">The shop isn't open yet. Your gold keeps accruing.</p>
  {:else}
    {#if balance.held}
      <section class="state held" role="status">
        <Icon name="shield" size={22} />
        <div>
          <h2>Spending paused</h2>
          <p>
            Your gold is on a payout hold while your account is reviewed. It is kept, not lost.
            {#if balance.frozen > 0}{count(balance.frozen)} gold is waiting.{/if}
          </p>
        </div>
        <a class="btn" href="/codex#judging">View rules</a>
      </section>
    {/if}
    {#if notice}
      <p class="notice-line" class:wait={noticePending} role="status">
        <Icon name={noticePending ? 'hourglass' : 'circle-check'} size={18} />{notice}
        {#if !noticePending && cosmetics.length > 0}<a href="/gold/inventory">Open inventory</a>{/if}
      </p>
    {/if}

    {#if deals.length > 0}
      <div class="section-head">
        <h2 class="eyebrow">Today's deals</h2>
        <p class="refresh"><Icon name="hourglass" size={14} />New stock in {formatWait(Math.max(60, msLeft / 1000))}</p>
      </div>
      <div class="deals">
        {#each deals as card, i (card.id)}
          <ShopCard
            {card}
            variant="deal"
            index={i}
            sheen
            clock={formatClock(msLeft / 1000)}
            shortBy={short?.id === card.id ? short.by : 0}
            shakeKey={short?.id === card.id ? short.key : 0}
            stamped={stamped === card.id}
            onbuy={openConfirm}
          />
        {/each}
      </div>
    {/if}

    {#if packs.length > 0}
      <div class="section-head">
        <h2 class="eyebrow">Buzz packs</h2>
        <p class="refresh">Sent as Yellow Buzz to your Civitai wallet</p>
      </div>
      <div class="packs">
        {#each packs as card, i (card.id)}
          <ShopCard
            {card}
            variant="pack"
            index={deals.length + i}
            shortBy={short?.id === card.id ? short.by : 0}
            shakeKey={short?.id === card.id ? short.key : 0}
            stamped={stamped === card.id}
            onbuy={openConfirm}
          />
        {/each}
      </div>
    {/if}

    <div class="duo">
      {#if memberships.length > 0}
        <section>
          <div class="section-head"><h2 class="eyebrow">Membership</h2><p class="refresh">Stacks after what you already have</p></div>
          <div class="stack">
            {#each memberships as card, i (card.id)}
              <ShopCard
                {card}
                variant="row"
                index={deals.length + packs.length + i}
                shortBy={short?.id === card.id ? short.by : 0}
                shakeKey={short?.id === card.id ? short.key : 0}
                stamped={stamped === card.id}
                onbuy={openConfirm}
              />
            {/each}
          </div>
        </section>
      {/if}
      {#if cosmetics.length > 0}
        <section>
          <div class="section-head"><h2 class="eyebrow">Cosmetics</h2><p class="refresh">Only from Knights of New Order</p></div>
          <div class="stack">
            {#each cosmetics as card, i (card.id)}
              <ShopCard
                {card}
                variant="row"
                index={deals.length + packs.length + memberships.length + i}
                shortBy={short?.id === card.id ? short.by : 0}
                shakeKey={short?.id === card.id ? short.key : 0}
                stamped={stamped === card.id}
                onbuy={openConfirm}
              />
            {/each}
          </div>
        </section>
      {/if}
    </div>

    {#if cards.length === 0}
      <p class="closed">The shelves are empty today. Come back after midnight UTC.</p>
    {/if}

    {#if data.recent.length > 0}
      <section class="recent" aria-labelledby="recent-title">
        <h2 id="recent-title" class="eyebrow muted-eyebrow">Recent purchases</h2>
        <ul>
          {#each data.recent as purchase (purchase.id)}
            {@const s = statusOf(purchase.status)}
            <li>
              <time datetime={purchase.at}>{dayFormat.format(new Date(purchase.at))}</time>
              <span class="what">{purchase.name}</span>
              <span class="cost">{count(purchase.gold)} gold</span>
              <span class="state-label {s.tone}">{s.label}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <p class="fine">
      <Icon name="shield-check" size={14} />Gold on payout hold can't be spent until the hold clears. Buzz packs replace converting gold one-for-one.
    </p>
  {/if}
</div>

{#if confirming}
  <PurchaseDialog
    card={confirming}
    spendable={balance.convertible}
    {requestKey}
    onclose={() => (confirming = null)}
    onbought={sequence}
  />
{/if}

<style>
  p {
    margin: 0;
  }
  .head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 2rem;
    margin-bottom: 1.5rem;
  }
  .intro {
    max-width: 34rem;
  }
  .purse {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    padding: 1.1rem 1.4rem;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-surface);
  }
  .label {
    color: var(--io-parchment-muted);
    font: 600 0.65rem/1.2 var(--io-font-ui);
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }
  .value {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.3rem;
    color: var(--io-gold);
    font: 700 2rem/1 var(--io-font-display);
    font-variant-numeric: tabular-nums;
  }
  .value.small {
    color: var(--io-parchment);
    font-size: 1.5rem;
  }
  .floater {
    position: absolute;
    top: -0.2rem;
    left: 100%;
    color: var(--io-crimson-text);
    font: 700 1rem/1 var(--io-font-ui);
    animation: mo-float var(--motion-milestone-min) var(--ease-out-quart) both;
  }
  .inv {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    min-height: 44px;
    padding: 0 1rem;
    border: 1px solid var(--io-gold-muted);
    border-radius: 6px;
    color: var(--io-parchment);
    font: 500 0.9rem/1 var(--io-font-ui);
    text-decoration: none;
  }
  .inv:hover {
    border-color: var(--io-gold);
  }
  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    margin: 1.75rem 0 0.8rem;
  }
  .section-head .eyebrow {
    margin: 0;
  }
  .refresh {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--io-parchment-muted);
    font: 400 0.8rem/1.2 var(--io-font-ui);
  }
  .deals {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1rem;
  }
  .packs {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1rem;
  }
  .duo {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 2rem;
    align-items: start;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .closed,
  .fine {
    margin-top: 1.5rem;
    color: var(--io-parchment-muted);
    font: 400 0.9rem/1.5 var(--io-font-ui);
  }
  .fine {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 2rem;
    font-size: 0.8rem;
  }
  .state {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem 1.25rem;
    border: 1.5px solid var(--io-crimson);
    border-radius: 8px;
    background: var(--io-surface);
    color: var(--io-crimson-text);
  }
  .state > div {
    flex: 1;
  }
  .state h2 {
    margin: 0 0 0.2rem;
    color: var(--io-parchment);
    font: 700 1.1rem/1.2 var(--io-font-display);
    text-transform: uppercase;
  }
  .state p {
    color: var(--io-parchment-muted);
    font: 400 0.9rem/1.4 var(--io-font-ui);
  }
  .notice-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.5rem;
    padding: 0.8rem 1rem;
    border: 1px solid var(--io-verdigris);
    border-radius: 8px;
    color: var(--io-parchment);
    font: 400 0.9rem/1.4 var(--io-font-ui);
    animation: mo-fade-in var(--motion-base) var(--ease-out-quart);
  }
  .notice-line.wait {
    border-color: var(--io-gold-muted);
  }
  .notice-line a {
    color: var(--io-gold);
  }
  .muted-eyebrow {
    margin: 2rem 0 0.5rem;
    color: var(--io-parchment-muted);
  }
  .recent ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .recent li {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    padding: 0.6rem 0;
    border-bottom: 1px solid var(--io-gold-muted);
  }
  .recent time {
    flex: 0 0 4.5rem;
    color: var(--io-parchment-muted);
    font: 400 0.85rem/1.3 var(--io-font-ui);
  }
  .what {
    flex: 1;
    min-width: 0;
    color: var(--io-parchment);
    font: 400 1.1rem/1.3 var(--io-font-body);
  }
  .cost {
    color: var(--io-parchment-muted);
    font: 400 0.85rem/1.3 var(--io-font-ui);
  }
  .state-label {
    flex: none;
    min-width: 5.5rem;
    text-align: right;
    font: 600 0.8rem/1.3 var(--io-font-ui);
    color: var(--io-parchment-muted);
  }
  .state-label.open {
    color: var(--io-gold);
  }
  .state-label.paid {
    color: var(--io-verdigris);
  }
  .state-label.failed {
    color: var(--io-crimson-text);
  }

  @media (max-width: 63.99rem) {
    .deals {
      grid-template-columns: 1fr;
    }
    .packs {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .duo {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 47.99rem) {
    .head {
      flex-direction: column;
      align-items: stretch;
      gap: 1rem;
    }
    .purse {
      flex-wrap: wrap;
      gap: 1rem;
    }
    .inv {
      flex: 1 0 100%;
      justify-content: center;
    }
    .value {
      font-size: 1.7rem;
    }
    .state {
      flex-wrap: wrap;
    }
  }
</style>

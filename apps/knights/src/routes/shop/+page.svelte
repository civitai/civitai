<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { count, formatClock, formatWait } from '$lib/format';
  import Icon from '$lib/Icon.svelte';
  import { reducedMotion, tween } from '$lib/motion';
  import { PENDING_TEXT, buyClick, groupCosmetics, refusalText } from '$lib/shop-view';
  import CosmeticTile from './CosmeticTile.svelte';
  import MembershipCard from './MembershipCard.svelte';
  import PurchaseDialog from './PurchaseDialog.svelte';
  import ShopCard from './ShopCard.svelte';
  import TryOnDialog from './TryOnDialog.svelte';
  import type { PageData } from './$types';

  type Card = NonNullable<PageData['shop']>['cards'][number];
  const SEQUENCE_MS = 720;

  let { data }: { data: PageData } = $props();
  const balance = $derived(data.balance);
  const cards = $derived(data.shop?.cards ?? []);
  const deals = $derived(cards.filter((card) => card.deal));
  const rest = $derived(cards.filter((card) => !card.deal));
  const packs = $derived(rest.filter((card) => card.kind === 'buzz_pack'));
  const memberships = $derived(rest.filter((card) => card.kind === 'membership'));
  const cosmetics = $derived(rest.filter((card) => card.kind === 'cosmetic'));
  const shelves = $derived(groupCosmetics(cosmetics));
  // Buzz packs close together (conversion off, or no Buzz endpoint): said once for the shelf, not on every card.
  const packsClosed = $derived(packs.length > 0 && packs.every((card) => card.state === 'closed'));
  const username = $derived(data.player?.username ?? 'YourName');
  const rankLine = $derived(
    data.status ? `${data.status.rank} · Level ${count(data.status.level)}` : ''
  );

  // The clock follows the server's, so a skewed device still counts down to the real UTC midnight.
  const skew = untrack(() => Date.parse(data.now) - Date.now());
  let nowMs = $state(untrack(() => Date.parse(data.now)));
  const msLeft = $derived(data.shop ? Date.parse(data.shop.refreshesAt) - nowMs : 0);

  // The purse shows what the server last confirmed. Only a purchase's count-down overlays it, and only after the server answered.
  let counting = $state<number | null>(null);
  const shown = $derived(counting ?? balance.convertible);
  let openedWith = 0;
  let stopSequence = () => {};
  let floater = $state<{ amount: number; key: number } | null>(null);
  let stamped = $state<number | null>(null);
  let skipped = $state(false);
  let reloadedFor = '';
  let confirming = $state<Card | null>(null);
  // The id, not the card: the dialog always shows the live card, and closes if a reload drops it.
  let tryingId = $state<number | null>(null);
  const trying = $derived(tryingId === null ? null : (cards.find((card) => card.id === tryingId) ?? null));
  $effect(() => {
    if (tryingId !== null && !trying) tryingId = null;
  });
  let requestKey = $state('');
  let short = $state<{ id: number; key: number; by: number; refusal: string | null } | null>(null);
  let notice = $state<string | null>(null);
  let noticePending = $state(false);
  let noticeInventory = $state(false);

  onMount(() => {
    const timer = setInterval(() => {
      nowMs = Date.now() + skew;
      // once per day's stock: a reload that does not move `refreshesAt` must not be repeated every second
      if (data.shop && data.shop.refreshesAt !== reloadedFor && Date.parse(data.shop.refreshesAt) - nowMs <= 0) {
        reloadedFor = data.shop.refreshesAt;
        void invalidateAll();
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      stopSequence();
    };
  });

  function openConfirm(card: Card) {
    notice = null;
    const click = buyClick(balance, card.price);
    if (click.kind !== 'confirm') {
      short = {
        id: card.id,
        key: (short?.key ?? 0) + 1,
        by: click.kind === 'short' ? click.by : 0,
        refusal: click.kind === 'refused' ? click.text : null,
      };
      return;
    }
    short = null;
    requestKey = crypto.randomUUID();
    openedWith = balance.convertible;
    confirming = card;
  }

  function sequence(card: Card, pending: boolean) {
    stopSequence();
    confirming = null;
    const from = openedWith;
    const to = balance.convertible;
    stamped = card.id;
    noticePending = pending;
    noticeInventory = card.kind === 'cosmetic' && !pending;
    notice = pending
      ? PENDING_TEXT
      : card.kind === 'cosmetic'
      ? `${card.name} is yours. Equip it from your inventory.`
      : card.kind === 'membership'
      ? 'One week of membership perks added to your Civitai account.'
      : `${count(card.buzz ?? 0)} Buzz sent to your Civitai wallet.`;
    if (!reducedMotion() && from !== to) floater = { amount: from - to, key: Date.now() };
    skipped = false;
    counting = from;
    const cancel = tween(from, to, 360, (value) => (counting = Math.round(value)));
    const events = ['pointerdown', 'keydown'] as const;
    const finish = () => {
      cancel();
      for (const event of events) window.removeEventListener(event, skip, true);
      clearTimeout(timer);
      counting = null;
      floater = null;
      stopSequence = () => {};
    };
    function skip() {
      skipped = true;
      finish();
    }
    const timer = setTimeout(finish, SEQUENCE_MS);
    for (const event of events) window.addEventListener(event, skip, true);
    stopSequence = finish;
  }

  const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const STATUS = {
    pending: { label: 'On its way', tone: 'open' },
    granted: { label: 'Delivered', tone: 'paid' },
    failed: { label: 'Not delivered', tone: 'failed' },
  } as const;
  const statusOf = (status: string) =>
    status in STATUS ? STATUS[status as keyof typeof STATUS] : { label: status, tone: '' };
</script>

<svelte:head>
  <title>Shop · Knights of New Order</title>
</svelte:head>

<div class="page-wide shop" data-skipped={skipped ? '' : undefined}>
  <header class="head">
    <div class="intro">
      <p class="eyebrow">The Armory</p>
      <h1 class="page-title">Shop</h1>
      <p class="lede">
        Spend the gold your judgments earn on Buzz, membership and cosmetics that only Knights can wear.
      </p>
    </div>
    <div class="purse" role="group" aria-label="Your gold">
      <div class="figure">
        <p class="label">Spendable gold</p>
        <p class="value">
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
      <a class="inv" href="/shop/inventory" data-sveltekit-preload-data="hover"><Icon name="store" size={16} />Inventory</a>
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
        {#if noticeInventory}<a href="/shop/inventory">Open inventory</a>{/if}
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
            refusal={short?.id === card.id ? short.refusal : null}
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
      {#if packsClosed}<p class="shelf-note" role="status"><Icon name="hourglass" size={14} />{refusalText('closed')}</p>{/if}
      <div class="packs">
        {#each packs as card, i (card.id)}
          <ShopCard
            {card}
            variant="pack"
            index={deals.length + i}
            shortBy={short?.id === card.id ? short.by : 0}
            shakeKey={short?.id === card.id ? short.key : 0}
            refusal={short?.id === card.id ? short.refusal : null}
            stamped={stamped === card.id}
            onbuy={openConfirm}
          />
        {/each}
      </div>
    {/if}

    {#if memberships.length > 0}
      <div class="section-head">
        <h2 class="eyebrow">Membership · 7 days</h2>
        <p class="refresh">Perks only, if you have no membership</p>
      </div>
      <div class="tiers">
        {#each memberships as card, i (card.id)}
          <MembershipCard
            {card}
            {balance}
            index={deals.length + packs.length + i}
            shortBy={short?.id === card.id ? short.by : 0}
            shakeKey={short?.id === card.id ? short.key : 0}
            refusal={short?.id === card.id ? short.refusal : null}
            onbuy={openConfirm}
          />
        {/each}
      </div>
    {/if}

    {#if cosmetics.length > 0}
      <div class="section-head">
        <h2 class="eyebrow">Cosmetics</h2>
        <p class="refresh">Only from Knights of New Order · select one to try it on</p>
      </div>
      {#each shelves as shelf, s (shelf.key)}
        <section class="shelf" aria-labelledby="shelf-{shelf.key}">
          <div class="shelf-head">
            <h3 id="shelf-{shelf.key}">{shelf.label}</h3>
            {#if shelf.note}<p>{shelf.note}</p>{/if}
          </div>
          <div class="tiles">
            {#each shelf.cards as card, i (card.id)}
              <CosmeticTile
                {card}
                {username}
                {balance}
                index={deals.length + packs.length + memberships.length + s * 4 + i}
                shortBy={short?.id === card.id ? short.by : 0}
                shakeKey={short?.id === card.id ? short.key : 0}
                refusal={short?.id === card.id ? short.refusal : null}
                stamped={stamped === card.id}
                onbuy={openConfirm}
                ontry={(picked) => (tryingId = picked.id)}
              />
            {/each}
          </div>
        </section>
      {/each}
    {/if}

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
      <Icon name="shield-check" size={14} />Gold on payout hold can't be spent until the hold clears.
    </p>
  {/if}
</div>

{#if trying}
  <TryOnDialog
    card={trying}
    {username}
    avatarUrl={data.player?.avatarUrl ?? null}
    {rankLine}
    {balance}
    onclose={() => (tryingId = null)}
    onbuy={(card) => {
      tryingId = null;
      openConfirm(card);
    }}
  />
{/if}

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
  .tiers {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1rem;
  }
  .shelf {
    margin-top: 1.25rem;
  }
  .shelf-note {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: -0.25rem 0 0.75rem;
    color: var(--io-parchment-muted);
    font: 400 0.85rem/1.4 var(--io-font-ui);
  }
  .shelf-head {
    display: flex;
    align-items: baseline;
    gap: 0.625rem;
    margin-bottom: 0.75rem;
  }
  .shelf-head h3 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 1.06rem/1.2 var(--io-font-display);
    letter-spacing: 0.04em;
  }
  .shelf-head p {
    color: var(--io-parchment-muted);
    font: 400 0.75rem/1.2 var(--io-font-ui);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1rem;
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
    .tiers {
      grid-template-columns: 1fr;
    }
    .tiles {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  @media (max-width: 47.99rem) {
    .tiles {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.625rem;
    }
    .recent li {
      flex-wrap: wrap;
      row-gap: 0.15rem;
    }
    .recent .what {
      flex: 1 0 60%;
    }
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

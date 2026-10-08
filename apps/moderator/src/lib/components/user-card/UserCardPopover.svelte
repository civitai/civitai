<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import {
    Popover,
    PopoverArrow,
    PopoverContent,
  } from '@civitai/ui/components/ui/popover/index.js';
  import type { Jsonified } from '$lib/format';
  import type { UserCard as UserCardData } from '$lib/server/user-lookup.service';
  import UserCard from './UserCard.svelte';

  // Mounted once in the root layout and delegated from the document, so EVERY link to User Lookup gets
  // the card — including ones added later — without each call site opting in.

  const OPEN_DELAY = 350;
  const CLOSE_DELAY = 200;
  // Long enough to hover down a list of owners without refetching. Actions taken in this tab clear it
  // (see the effect below); this bounds what an action in ANOTHER tab leaves stale.
  const CACHE_MS = 60_000;

  type Loaded = Jsonified<UserCardData> | null;
  const cache = new Map<string, { at: number; card: Promise<Loaded> }>();

  function fetchCard(q: string): Promise<Loaded> {
    const hit = cache.get(q);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.card;
    const card = fetch(`/api/user-card?q=${encodeURIComponent(q)}`).then((r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(String(r.status));
      return r.json() as Promise<Jsonified<UserCardData>>;
    });
    // A failure is not cached: the next hover retries.
    card.catch(() => {
      if (cache.get(q)?.card === card) cache.delete(q);
    });
    cache.set(q, { at: Date.now(), card });
    return card;
  }

  // A form action reloads page data. Without this a card hovered before a ban or a strike kept showing
  // the account as it was, beside a header that had already updated.
  $effect(() => {
    void page.data;
    cache.clear();
  });

  let open = $state(false);
  let anchor = $state<HTMLAnchorElement | null>(null);
  let term = $state<string | null>(null);
  const card = $derived(open && term ? fetchCard(term) : null);

  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelClose = () => clearTimeout(closeTimer);
  const scheduleClose = () => {
    clearTimeout(openTimer);
    cancelClose();
    closeTimer = setTimeout(() => (open = false), CLOSE_DELAY);
  };

  function userLookupLink(target: EventTarget | null) {
    if (!(target instanceof Element)) return null;
    // The card's own "Open in User Lookup" link would otherwise re-open the card it sits in.
    if (target.closest('[data-user-card-popover]')) return null;
    const a = target.closest<HTMLAnchorElement>('a[href]');
    if (!a) return null;
    const url = new URL(a.href, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/retool/user-lookup'))
      return null;
    const q = url.searchParams.get('q')?.trim();
    if (!q) return null;
    // User Lookup's own section links all name the account whose card is already above them.
    const here = page.url;
    if (here.pathname.startsWith('/retool/user-lookup') && q === here.searchParams.get('q')?.trim())
      return null;
    return { a, q };
  }

  function enter(e: Event) {
    const link = userLookupLink(e.target);
    if (!link) return;
    cancelClose();
    if (open && anchor === link.a) return;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => {
      anchor = link.a;
      term = link.q;
      open = true;
    }, OPEN_DELAY);
  }

  function leave(e: PointerEvent | FocusEvent) {
    const link = userLookupLink(e.target);
    if (link && !(e.relatedTarget instanceof Node && link.a.contains(e.relatedTarget)))
      scheduleClose();
  }

  afterNavigate(() => {
    clearTimeout(openTimer);
    open = false;
    cache.clear();
  });
</script>

<!-- Focus opens it only from the keyboard: a click focuses the link too, and would pop the card over
     the page being left. Keyboard users get a read-only card — focus leaving the link closes it. -->
<svelte:document
  onpointerover={(e) => e.pointerType !== 'touch' && enter(e)}
  onpointerout={leave}
  onfocusin={(e) => e.target instanceof Element && e.target.matches(':focus-visible') && enter(e)}
  onfocusout={leave}
/>

<Popover bind:open>
  <PopoverContent
    customAnchor={anchor}
    side="bottom"
    align="center"
    sideOffset={2}
    trapFocus={false}
    onOpenAutoFocus={(e) => e.preventDefault()}
    onCloseAutoFocus={(e) => e.preventDefault()}
    onpointerenter={cancelClose}
    onpointerleave={scheduleClose}
    data-user-card-popover
    class="w-[min(36rem,calc(100vw-2rem))] rounded-xl bg-transparent p-0 shadow-xl ring-0"
  >
    {#if card}
      {#await card}
        <div class="rounded-xl border border-dark-4 bg-dark-6 p-3 text-sm text-dark-2">
          Loading {term}…
        </div>
      {:then loaded}
        {#if loaded}
          <UserCard card={loaded} compact lookupLink />
        {:else}
          <div class="rounded-xl border border-dark-4 bg-dark-6 p-3 text-sm text-dark-2">
            No user matches <code>{term}</code>.
          </div>
        {/if}
      {:catch}
        <div class="rounded-xl border border-dark-4 bg-dark-6 p-3 text-sm text-red-300">
          Could not load this user's card.
        </div>
      {/await}
    {/if}
    <PopoverArrow class="border-r border-b border-dark-4 bg-dark-6" />
  </PopoverContent>
</Popover>

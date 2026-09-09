<script lang="ts">
  import { LINK_CLASS, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { SharedAddress, SharedIpAccount } from '$lib/server/reactor-lookup.service';

  let {
    accounts,
    noisyThreshold,
  }: { accounts: SharedIpAccount[]; noisyThreshold: number } = $props();

  // An account is only worth listing if at least one of its addresses is narrow enough to identify
  // anyone. Everything else is a carrier NAT or a VPN exit, where a match means nothing — kept, but
  // out of the way, because a moderator does need to be able to see that it was checked.
  const narrow = (a: SharedAddress) => a.totalAccounts !== null && a.totalAccounts <= noisyThreshold;
  const identifying = (acc: SharedIpAccount) => acc.addresses.some(narrow);

  const withCreator = $derived(accounts.filter((a) => a.withTarget && identifying(a)));
  const betweenReactors = $derived(accounts.filter((a) => !a.withTarget && identifying(a)));
  const weak = $derived(accounts.filter((a) => !identifying(a)));

  const breadth = (a: SharedAddress) =>
    a.totalAccounts === null ? 'unmeasured' : `${num(a.totalAccounts)} site-wide`;

  const MAX_SHOWN = 5;
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-sm font-semibold text-white">Shared addresses</h2>
  <p class="mb-4 text-xs text-dark-2">
    Accounts from the list opposite that have ever been seen on an address with someone else on it —
    not limited to the lookback, since an address link is evidence of identity rather than of recent
    activity. IPv6 grouped by /64.
    <strong class="text-dark-0">Read the site-wide count</strong>: two accounts on an address carrying
    only those two is decisive, the same two on a VPN exit carrying hundreds is nothing.
  </p>

  {#snippet group(rows: SharedIpAccount[])}
    <ul class="space-y-4">
      {#each rows as acc (acc.userId)}
        <li>
          <div class="flex flex-wrap items-baseline gap-x-2">
            <a href={userLookupUrl(acc.userId)} class="{LINK_CLASS} font-medium">
              {acc.username ?? `#${acc.userId}`}
            </a>
            <span class="text-xs text-dark-2">
              {num(acc.addressCount)}
              {acc.addressCount === 1 ? 'address' : 'addresses'} with
            </span>
            {#each acc.peers as p (p.userId)}
              <a
                href={userLookupUrl(p.userId)}
                class="{LINK_CLASS} text-xs {p.isTarget ? 'font-semibold text-red-300' : ''}"
              >
                {p.username ?? `#${p.userId}`}{p.isTarget ? ' (the creator)' : ''}
              </a>
            {/each}
          </div>
          <ul class="mt-1 space-y-0.5">
            {#each acc.addresses.slice(0, MAX_SHOWN) as a (a.cluster)}
              <li class="flex flex-wrap items-baseline gap-x-2 text-xs">
                <code class="break-all {narrow(a) ? 'text-dark-0' : 'text-dark-2'}">{a.cluster}</code>
                <span class="text-dark-2">{breadth(a)}</span>
              </li>
            {/each}
            {#if acc.addressCount > MAX_SHOWN}
              <li class="text-xs text-dark-2">
                +{num(acc.addressCount - MAX_SHOWN)} more, narrowest shown
              </li>
            {/if}
          </ul>
        </li>
      {/each}
    </ul>
  {/snippet}

  {#if accounts.length === 0}
    <p class="text-sm text-dark-2">No shared addresses.</p>
  {:else}
    <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-red-300">
      Shares an address with the creator ({num(withCreator.length)})
    </h3>
    {#if withCreator.length}
      <p class="mb-3 text-xs text-dark-2">
        This account and the one it is boosting were on the same address. This is the finding.
      </p>
      {@render group(withCreator)}
    {:else}
      <p class="mb-4 text-sm text-dark-2">None.</p>
    {/if}

    <h3 class="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-yellow-300">
      Shares with another reactor ({num(betweenReactors.length)})
    </h3>
    {#if betweenReactors.length}
      <p class="mb-3 text-xs text-dark-2">A lead, not a conclusion.</p>
      {@render group(betweenReactors)}
    {:else}
      <p class="text-sm text-dark-2">None.</p>
    {/if}

    {#if weak.length}
      <details class="mt-6">
        <summary class="text-xs text-dark-2">
          {num(weak.length)} on wide or unmeasured addresses only
        </summary>
        <p class="mb-3 mt-2 text-xs text-dark-2">
          Every address these share carries over {noisyThreshold} accounts, or has no activity history
          to measure against. Carrier NATs, office ranges and VPN exits land here; a match on one is not
          by itself evidence.
        </p>
        {@render group(weak)}
      </details>
    {/if}
  {/if}
</section>

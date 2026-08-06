<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, num } from './format';

  export type Signals = {
    ips: { ip: string; type: string; first: string; last: string; events: number }[];
    sharedAccounts: {
      userId: number;
      username: string | null;
      bannedAt: string | null;
      ip: string;
      type: string;
      last: string;
    }[];
    truncated: boolean;
    commentBurst: number;
  };

  let { userId }: { userId: number } = $props();

  const SHOWN = 12;

  // Fetched here rather than in the page load: ~500ms of ClickHouse work that must not hold up identity.
  // Derived promise + {#await} means there is no state to reassign — a new userId produces a new promise
  // and the template re-awaits it, so a stale response cannot land on a newer lookup. `browser` keeps SSR
  // from issuing the request.
  const signals = $derived(
    browser
      ? fetch(`/api/user-signals/${userId}`).then((r): Promise<Signals> => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
      : null
  );
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Security signals</h3>
  <p class="mb-3 text-xs text-dark-2">
    Addresses this account was seen on, and other accounts sharing the ones it registered or subscribed
    from. Internal traffic excluded.
  </p>

  {#await signals}
    <p class="text-sm text-dark-2">Checking addresses and linked accounts…</p>
  {:then result}
    {#if result}
      {#if result.commentBurst > 2}
        <div
          class="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-200"
        >
          {num(result.commentBurst)} comments in the last 48 hours — possible spam burst.
        </div>
      {/if}

      <div class="grid gap-5 lg:grid-cols-2">
        <div>
          <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
            Addresses ({result.ips.length})
          </h4>
          {#if result.ips.length === 0}
            <p class="text-sm text-dark-2">No activity recorded.</p>
          {:else}
            <ul class="space-y-1 text-sm">
              {#each result.ips.slice(0, SHOWN) as row (row.ip + row.type)}
                <li class="flex flex-wrap items-baseline gap-x-2">
                  <code class="text-dark-0">{row.ip}</code>
                  <Badge variant="secondary">{row.type}</Badge>
                  <span class="text-xs text-dark-2">{row.events}× · last {row.last}</span>
                </li>
              {/each}
            </ul>
            {#if result.ips.length > SHOWN}
              <p class="mt-2 text-xs text-dark-2">+{result.ips.length - SHOWN} more</p>
            {/if}
          {/if}
        </div>

        <div>
          <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
            Accounts sharing those addresses ({result.sharedAccounts.length}{result.truncated
              ? '+'
              : ''})
          </h4>
          {#if result.sharedAccounts.length === 0}
            <p class="text-sm text-dark-2">None found.</p>
          {:else}
            <ul class="space-y-1 text-sm">
              {#each result.sharedAccounts.slice(0, SHOWN) as acct (`${acct.userId}:${acct.ip}:${acct.type}`)}
                <li class="flex flex-wrap items-baseline gap-x-2">
                  <a href="?q={acct.userId}" class={LINK_CLASS}>
                    {acct.username ?? `#${acct.userId}`}
                  </a>
                  {#if acct.bannedAt}
                    <Badge variant="destructive">banned</Badge>
                  {/if}
                  <code class="text-xs text-dark-2">{acct.ip}</code>
                </li>
              {/each}
            </ul>
            {#if result.truncated}
              <p class="mt-2 text-xs text-amber-300">
                Capped — this address is shared widely, so matches here may be coincidental.
              </p>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load security signals.</p>
  {/await}
</section>

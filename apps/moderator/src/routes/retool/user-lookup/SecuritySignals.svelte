<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, num } from './format';

  type Account = { userId: number; username: string | null; bannedAt: string | null };

  export type Signals = {
    commentBurst: number;
    ips: {
      addresses: { ip: string; type: string; first: string; last: string; events: number }[];
      accounts: (Account & { ip: string; type: string; last: string })[];
      truncated: boolean;
    };
    socials: {
      links: { id: number; url: string; type: string }[];
      accounts: (Account & { url: string })[];
      truncated: boolean;
    };
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

  // Social URLs are user-controlled and Svelte does not sanitise hrefs, so a `javascript:` link would
  // execute in a moderator's session. Anything that is not plain http(s) renders as text.
  const safeHref = (url: string) => (/^https?:\/\//i.test(url.trim()) ? url : null);
</script>

{#snippet accountLine(acct: { userId: number; username: string | null; bannedAt: string | null })}
  <a href="?q={acct.userId}" class={LINK_CLASS}>{acct.username ?? `#${acct.userId}`}</a>
  {#if acct.bannedAt}
    <Badge variant="destructive">banned</Badge>
  {/if}
{/snippet}

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Security signals</h3>
  <p class="mb-3 text-xs text-dark-2">
    Addresses and links this account was seen on, and other accounts sharing them. Only the addresses it
    registered or subscribed from are matched; internal traffic excluded.
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
            Addresses ({result.ips.addresses.length})
          </h4>
          {#if result.ips.addresses.length === 0}
            <p class="text-sm text-dark-2">No activity recorded.</p>
          {:else}
            <ul class="space-y-1 text-sm">
              {#each result.ips.addresses.slice(0, SHOWN) as row (`${row.ip}:${row.type}`)}
                <li class="flex flex-wrap items-baseline gap-x-2">
                  <code class="text-dark-0">{row.ip}</code>
                  <Badge variant="secondary">{row.type}</Badge>
                  <span class="text-xs text-dark-2">{row.events}× · last {row.last}</span>
                </li>
              {/each}
            </ul>
            {#if result.ips.addresses.length > SHOWN}
              <p class="mt-2 text-xs text-dark-2">+{result.ips.addresses.length - SHOWN} more</p>
            {/if}
          {/if}
        </div>

        <div>
          <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
            Accounts sharing those addresses ({result.ips.accounts.length}{result.ips.truncated
              ? '+'
              : ''})
          </h4>
          {#if result.ips.accounts.length === 0}
            <p class="text-sm text-dark-2">None found.</p>
          {:else}
            <ul class="space-y-1 text-sm">
              {#each result.ips.accounts.slice(0, SHOWN) as acct (`${acct.userId}:${acct.ip}:${acct.type}`)}
                <li class="flex flex-wrap items-baseline gap-x-2">
                  {@render accountLine(acct)}
                  <code class="text-xs text-dark-2">{acct.ip}</code>
                </li>
              {/each}
            </ul>
            {#if result.ips.truncated}
              <p class="mt-2 text-xs text-amber-300">
                Capped — this address is shared widely, so matches here may be coincidental.
              </p>
            {/if}
          {/if}
        </div>
      </div>

      <div class="mt-5 grid gap-5 border-t border-dark-4 pt-4 lg:grid-cols-2">
        <div>
          <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
            Social links ({result.socials.links.length})
          </h4>
          {#if result.socials.links.length === 0}
            <p class="text-sm text-dark-2">None on this account.</p>
          {:else}
            <ul class="space-y-1 text-sm">
              {#each result.socials.links as link (link.id)}
                <li class="flex flex-wrap items-baseline gap-x-2">
                  <Badge variant="secondary">{link.type}</Badge>
                  {#if safeHref(link.url)}
                    <a
                      href={safeHref(link.url)}
                      target="_blank"
                      rel="noreferrer noopener"
                      class="break-all {LINK_CLASS}"
                    >
                      {link.url}
                    </a>
                  {:else}
                    <span class="break-all text-dark-0">{link.url}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <div>
          <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
            Accounts sharing those links ({result.socials.accounts.length}{result.socials.truncated
              ? '+'
              : ''})
          </h4>
          {#if result.socials.accounts.length === 0}
            <p class="text-sm text-dark-2">None found.</p>
          {:else}
            <ul class="space-y-1 text-sm">
              {#each result.socials.accounts as acct (acct.userId)}
                <li class="flex flex-wrap items-baseline gap-x-2">
                  {@render accountLine(acct)}
                  <span class="truncate text-xs text-dark-2">{acct.url}</span>
                </li>
              {/each}
            </ul>
            {#if result.socials.truncated}
              <p class="mt-2 text-xs text-amber-300">
                Capped — more accounts share these links than are shown.
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

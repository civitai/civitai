<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { Signals } from './signals';

  let { signals }: { signals: Promise<Signals> | null } = $props();

  const SHOWN = 12;
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Addresses &amp; linked accounts</h3>
  <p class="mb-3 text-xs text-dark-2">
    Only the addresses this account registered or subscribed from are matched — a login IP is often a
    shared carrier address. Internal traffic excluded.
  </p>

  {#await signals}
    <p class="text-sm text-dark-2">Checking addresses…</p>
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
                  <span class="text-xs text-dark-2">{row.events}× · last {dateTime(row.last)}</span>
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
            Accounts sharing them ({result.ips.accounts.length}{result.ips.truncated ? '+' : ''})
          </h4>
          {#if result.ips.accounts.length === 0}
            <p class="text-sm text-dark-2">None found.</p>
          {:else}
            <ul class="space-y-1 text-sm">
              {#each result.ips.accounts.slice(0, SHOWN) as acct (`${acct.userId}:${acct.ip}:${acct.type}`)}
                <li class="flex flex-wrap items-baseline gap-x-2">
                  <a href="?q={acct.userId}" class={LINK_CLASS}>
                    {acct.username ?? `#${acct.userId}`}
                  </a>
                  {#if acct.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
                  {#if acct.muted}<Badge variant="destructive">muted</Badge>{/if}
                  {#if acct.strikes > 0}
                    <Badge variant="destructive">
                      {acct.strikes}
                      {acct.strikes === 1 ? 'strike' : 'strikes'}
                    </Badge>
                  {/if}
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

      <div class="mt-5 border-t border-dark-4 pt-4">
        <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
          Account history ({result.events.length})
        </h4>
        {#if result.events.length === 0}
          <p class="text-sm text-dark-2">No recorded account events.</p>
        {:else}
          <ul class="space-y-1 text-sm">
            {#each result.events.slice(0, SHOWN) as e (e.key)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <Badge variant="secondary">{e.type}</Badge>
                <span class="text-xs text-dark-2">{dateTime(e.time)}</span>
                {#if e.actorId}
                  <span class="text-xs text-dark-2">
                    by <a href="?q={e.actorId}" class={LINK_CLASS}>{e.actor ?? `#${e.actorId}`}</a>
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
          {#if result.events.length > SHOWN}
            <p class="mt-2 text-xs text-dark-2">+{result.events.length - SHOWN} more</p>
          {/if}
        {/if}
      </div>
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load addresses.</p>
  {/await}
</section>

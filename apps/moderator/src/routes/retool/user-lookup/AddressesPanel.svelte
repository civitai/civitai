<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { Signals } from './signals';
  import SharedIpAccounts from '$lib/components/SharedIpAccounts.svelte';

  let { signals, accountId }: { signals: Promise<Signals> | null; accountId: number } = $props();

  const SHOWN = 12;

</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Addresses &amp; linked accounts</h3>
  <p class="mb-3 text-xs text-dark-2">
    The 100 most recently used addresses, internal traffic and ban events excluded. Linked accounts
    are matched only on the addresses this account registered or subscribed from — a login IP is
    often a shared carrier address.
  </p>

  {#await signals}
    <p class="text-sm text-dark-2">Checking addresses…</p>
  {:then result}
    {#if result}
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
                <li>
                  <div class="flex flex-wrap items-baseline gap-x-2">
                    <code class="text-dark-0">{row.ip}</code>
                    <Badge variant="secondary">{row.type}</Badge>
                    <span class="text-xs text-dark-2">
                      {num(row.events)} events from this address, all time
                    </span>
                  </div>
                  <div class="text-xs text-dark-2">
                    first {dateTime(row.first)} · last {dateTime(row.last)}
                  </div>
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
          <SharedIpAccounts
            {accountId}
            accounts={result.ips.accounts}
            truncated={result.ips.truncated}
            shown={SHOWN}
          />
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

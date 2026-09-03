<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { Signals } from './signals';

  let { signals }: { signals: Promise<Signals> | null } = $props();

  const SHOWN = 12;

  // The list is capped at SHOWN for reading; the ids are not. One account per row is the display, but
  // the same account appears once per shared address, so the set has to be deduped before it is any
  // use as a ban list.
  const uniqueIds = (accounts: { userId: number }[]) => [...new Set(accounts.map((a) => a.userId))];
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

            <!-- This panel is where a ring gets identified and Bulk Ban is where it gets dealt with;
                 the ids in between were reachable only one row link at a time. -->
            {#key result.ips.accounts}
              {@const ids = uniqueIds(result.ips.accounts)}
              <div class="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  href="/retool/bulk-ban?ids={encodeURIComponent(ids.join('\n'))}"
                >
                  Check {num(ids.length)} in Bulk Ban
                </Button>
              </div>
              <details class="mt-2">
                <summary class="cursor-pointer text-xs text-dark-2">
                  Copy {num(ids.length)} unique ID{ids.length === 1 ? '' : 's'}
                </summary>
                <Textarea
                  readonly
                  rows={4}
                  class="mt-2 max-h-40 overflow-y-auto font-mono text-xs"
                  value={ids.join('\n')}
                />
              </details>
            {/key}
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

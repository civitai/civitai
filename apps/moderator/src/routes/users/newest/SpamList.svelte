<script lang="ts">
  import { page } from '$app/state';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { urlWith } from '$lib/url';
  import { domainOf } from './domain';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const window = (d: number) => urlWith(page.url, { view: 'spam', spamDays: d, cursor: null });
  const hours = (n: number) => (n < 1 ? '<1h' : `${Math.round(n)}h`);
</script>

<section class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-dark-2">
  <span class="flex items-center gap-2">
    Burst within
    {#each data.spamWindows as d (d)}
      <a href={window(d)} class={d === data.spamDays ? 'text-white underline' : LINK_CLASS}>
        {d === 1 ? '24h' : `${d}d`}
      </a>
    {/each}
  </span>
  <!-- "Showing", not a total: the ClickHouse read is capped, and the cap is applied BEFORE the
       already-banned and too-old rows are dropped, so this is neither the match count nor the cap. -->
  <!-- Bursts, not accounts: one account can qualify in two separate hours and appears once per hour. -->
  <span>
    Showing {num(data.spam.length)} bursts{data.spamTruncated ? ' — capped, narrow the window' : ''}
  </span>
</section>

{#if data.spam.length === 0}
  <p class="text-sm text-dark-2">
    Nothing matches the signature in this window. That is the normal state between waves.
  </p>
{:else}
  <div class="rounded-xl border border-dark-4 bg-dark-6">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Account</TableHead>
          <TableHead>Burst</TableHead>
          <TableHead>Age when it happened</TableHead>
          <TableHead>Email</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <!-- Keyed on the hour too: one account can legitimately appear for two separate bursts. -->
        {#each data.spam as a (`${a.userId}-${new Date(a.hour).getTime()}`)}
          {@const domain = domainOf(a.email)}
          <TableRow>
            <TableCell class="align-top">
              <a href={userLookupUrl(a.userId)} class={LINK_CLASS}>
                {a.username ?? `user ${a.userId}`}
              </a>
              <div class="mt-1 text-xs text-dark-2">{a.userId}</div>
            </TableCell>
            <TableCell class="align-top whitespace-nowrap">
              <span class="text-red-300">{num(a.comments)} comments</span> in an hour
              <div class="mt-1 text-xs text-dark-2">{dateTime(a.hour)}</div>
            </TableCell>
            <TableCell class="align-top whitespace-nowrap">{hours(a.ageAtBurstHours)} old</TableCell>
            <TableCell class="align-top">
              <span class="break-all">{a.email ?? '—'}</span>
              {#if domain}
                <div class="mt-1 text-xs">
                  <a href="/retool/bulk-ban?domains={encodeURIComponent(domain)}" class={LINK_CLASS}>
                    others on @{domain}
                  </a>
                </div>
              {/if}
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </div>
{/if}

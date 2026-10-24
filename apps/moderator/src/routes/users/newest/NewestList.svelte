<script lang="ts">
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { LINK_CLASS, dateTime, num, plainText, relativeTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { urlWith } from '$lib/url';
  import CursorPager from '$lib/components/CursorPager.svelte';
  import { domainOf } from './domain';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Cursor dropped: a new filter must start at the newest account, not part-way down an unseen list.
  const filtered = (params: Record<string, string | number | null>) =>
    urlWith(page.url, { ...params, cursor: null });
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <form method="GET" class="flex flex-wrap items-end gap-3">
    <!-- Keyed on the URL so the boxes re-seed from `data` on every navigation. `Input`'s `value` is
         `$bindable`: passed one-way it keeps whatever was typed, because the parent expression does not
         change when a window or page link carries the old filter along. Remounting is what re-seeds it —
         a function binding with a no-op setter does NOT, it makes the box unwritable, since Svelte
         re-reads the getter after every keystroke and writes it back to the DOM. -->
    {#key page.url.search}
      <div>
        <Label for="username" class="text-xs text-dark-2">Username contains</Label>
        <Input id="username" name="username" value={data.username} class="mt-1 w-48" />
      </div>
      <div>
        <Label for="email" class="text-xs text-dark-2">Email contains</Label>
        <Input
          id="email"
          name="email"
          value={data.email}
          placeholder="@throwaway.example"
          class="mt-1 w-64"
        />
      </div>
    {/key}
    <input type="hidden" name="days" value={data.days} />
    <input type="hidden" name="limit" value={data.limit} />
    <Button type="submit" variant="outline">Filter</Button>
    {#if data.username || data.email}
      <Button variant="ghost" href={filtered({ username: null, email: null })}>Clear</Button>
    {/if}
  </form>

  <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-dark-2">
    <!-- No "all time": the window is what bounds the scan — see getNewestUsers. -->
    <span class="flex items-center gap-2">
      Registered within
      {#each data.windows as d (d)}
        <a href={filtered({ days: d })} class={d === data.days ? 'text-white underline' : LINK_CLASS}>
          {d === 1 ? '24h' : `${d}d`}
        </a>
      {/each}
    </span>
    <span class="flex items-center gap-2">
      Per page
      {#each data.pageSizes as size (size)}
        <a
          href={filtered({ limit: size })}
          class={size === data.limit ? 'text-white underline' : LINK_CLASS}
        >
          {size}
        </a>
      {/each}
    </span>
    <span>Showing {num(data.users.length)}</span>
  </div>
</section>

{#if data.users.length === 0}
  <p class="text-sm text-dark-2">
    {#if page.url.searchParams.has('cursor')}
      Nothing further back in this window.
      <a href={filtered({})} class={LINK_CLASS}>Back to the newest</a>.
    {:else}
      No accounts registered in this window match. Widen the window or clear the filters.
    {/if}
  </p>
{:else}
  <div class="rounded-xl border border-dark-4 bg-dark-6">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Account</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Registered</TableHead>
          <TableHead>Profile text</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each data.users as u (u.id)}
          {@const domain = domainOf(u.email)}
          <TableRow>
            <TableCell class="align-top">
              <a href={userLookupUrl(u.id)} class={LINK_CLASS}>{u.username ?? `user ${u.id}`}</a>
              <div class="mt-1 flex flex-wrap items-center gap-1">
                <span class="text-xs text-dark-2">{u.id}</span>
                {#if u.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
                {#if u.deletedAt}<Badge variant="secondary">deleted</Badge>{/if}
                {#if u.muted}<Badge variant="destructive">muted</Badge>{/if}
              </div>
            </TableCell>
            <TableCell class="align-top">
              <span class="break-all">{u.email ?? '—'}</span>
              <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-dark-2">
                {#if domain}
                  <a href={filtered({ email: `@${domain}` })} class={LINK_CLASS}>filter</a>
                  <!-- The window bounds this page, so a ring older than it is only visible from Bulk
                       Ban, which asks the same question across all time. -->
                  <a href="/retool/bulk-ban?domains={encodeURIComponent(domain)}" class={LINK_CLASS}>
                    all accounts on @{domain}
                  </a>
                {/if}
                {#if !u.emailVerified}<span class="text-amber-300">unverified</span>{/if}
              </div>
            </TableCell>
            <TableCell class="align-top whitespace-nowrap">
              {relativeTime(u.createdAt)}
              <div class="mt-1 text-xs text-dark-2">{dateTime(u.createdAt)}</div>
            </TableCell>
            <TableCell class="align-top">
              {#if u.bio || u.message}
                <p class="line-clamp-3 max-w-md text-dark-1">
                  {plainText(u.message ? `${u.message} ${u.bio ?? ''}` : u.bio)}
                </p>
              {:else}
                <span class="text-xs text-dark-2">—</span>
              {/if}
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </div>

  <CursorPager href={data.nextCursor ? urlWith(page.url, { cursor: data.nextCursor }) : null} />
{/if}

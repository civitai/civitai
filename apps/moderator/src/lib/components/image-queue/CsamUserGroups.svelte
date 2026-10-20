<script lang="ts">
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { csamReportUrl } from '$lib/entity-url';
  import { dateTime, num, LINK_CLASS } from '$lib/format';
  import type { CsamQueueUser } from '$lib/server/image-review.service';
  import CsamQueueTabs from './CsamQueueTabs.svelte';

  let {
    data,
  }: {
    data: {
      title: string;
      civitaiUrl: string;
      level: number;
      users: CsamQueueUser[];
      truncated: boolean;
    };
  } = $props();

  const queueHref = (userId: number) => `/images/csam?userId=${userId}&level=${data.level}`;
</script>

<header class="page-header flex flex-wrap items-center justify-between gap-2">
  <h1>{data.title}</h1>
  <CsamQueueTabs active="user" level={data.level} />
</header>

{#if data.truncated}
  <p class="mb-3 text-sm text-amber-300" role="status">
    Showing the first {num(data.users.length)} users, most flagged first.
  </p>
{/if}

{#if data.users.length === 0}
  <p class="text-sm text-dark-2">No images to review in this queue.</p>
{:else}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>User</TableHead>
        <TableHead class="text-right">Flagged</TableHead>
        <TableHead>CSAM report</TableHead>
        <TableHead></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each data.users as user (user.userId)}
        <TableRow>
          <TableCell>
            {user.username ?? '[deleted]'}
            <span class="text-xs text-dark-2">#{user.userId}</span>
          </TableCell>
          <TableCell class="text-right tabular-nums">{num(user.flagged)}</TableCell>
          <TableCell class="text-xs">
            {#if user.reportSentAt}
              Sent {dateTime(user.reportSentAt)}
            {:else if user.reported}
              <span class="text-amber-300">Filed, not sent</span>
            {:else}
              <span class="text-dark-2">None</span>
            {/if}
          </TableCell>
          <TableCell class="whitespace-nowrap text-right text-sm">
            <a href={queueHref(user.userId)} class={LINK_CLASS}>Images</a>
            <span class="text-dark-4">·</span>
            <a
              href={csamReportUrl(data.civitaiUrl, user.userId)}
              target="_blank"
              rel="noreferrer"
              class={LINK_CLASS}>Report page</a
            >
          </TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
{/if}

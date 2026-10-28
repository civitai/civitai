<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, MUTED_LINK_CLASS, dateTime, num, relativeTime } from '$lib/format';
  import type { TicketListResult } from '$lib/server/tickets/list';

  type Ok = Extract<TicketListResult, { status: 'ok' }>;
  let { result, detailBase, showEmail }: { result: Ok; detailBase: string; showEmail: boolean } =
    $props();
</script>

{#each result.warnings as warning (warning)}
  <p class="mb-3 rounded-lg border border-amber-700 bg-dark-6 p-3 text-sm text-amber-300">{warning}</p>
{/each}

<p class="text-dark-2 mb-3 text-sm">{num(result.rows.length)} live tickets, most recently updated first.</p>

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Ticket</TableHead>
      <TableHead>Subject</TableHead>
      <TableHead>Status</TableHead>
      <TableHead>Feature</TableHead>
      <TableHead>Router topic</TableHead>
      <TableHead>Requester</TableHead>
      <TableHead>Created</TableHead>
      <TableHead>Updated</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    {#each result.rows as row (row.id)}
      <TableRow>
        <TableCell class="whitespace-nowrap">
          <a class={LINK_CLASS} href="{detailBase}/{row.id}">#{row.id}</a>
          <a class="ml-1 {MUTED_LINK_CLASS}" href={row.freshdeskUrl} target="_blank" rel="noreferrer"
            >↗</a
          >
        </TableCell>
        <TableCell class="max-w-md whitespace-normal">{row.subject || '—'}</TableCell>
        <TableCell>{row.statusLabel}</TableCell>
        <TableCell>
          {#if row.cfFeature}
            {row.cfFeature}
          {:else}
            <span class="text-dark-2">none</span>
          {/if}
        </TableCell>
        <TableCell>
          {#if row.routerTopic}
            {#if row.cfFeature}
              <span class="text-dark-2">{row.routerTopic}</span>
            {:else}
              <Badge variant="outline">{row.routerTopic}</Badge>
            {/if}
          {:else}
            —
          {/if}
        </TableCell>
        <TableCell>
          {#if row.civitaiUserId}
            <a class={LINK_CLASS} href={userLookupUrl(row.civitaiUserId, 'basic')}
              >user {row.civitaiUserId}</a
            >
          {:else}
            <span class="text-dark-2">unlinked</span>
          {/if}
          {#if showEmail && row.requesterEmail}
            <div class="text-dark-2 text-xs">{row.requesterEmail}</div>
          {/if}
        </TableCell>
        <TableCell class="whitespace-nowrap" title={dateTime(row.createdAt)}>
          {relativeTime(row.createdAt)}
        </TableCell>
        <TableCell class="whitespace-nowrap" title={dateTime(row.updatedAt)}>
          {relativeTime(row.updatedAt)}
        </TableCell>
      </TableRow>
    {/each}
  </TableBody>
</Table>

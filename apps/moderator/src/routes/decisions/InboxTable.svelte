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
  import { GROUP_RULING_LABEL } from '$lib/decision-rulings';
  import { LINK_CLASS, MUTED_LINK_CLASS, num } from '$lib/format';
  import type { PageData } from './$types';

  let {
    rows,
    groupHref,
  }: { rows: PageData['rows']; groupHref: (groupKey: string) => string } = $props();
</script>

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Area</TableHead>
      <TableHead>Item (representative ticket)</TableHead>
      <TableHead class="text-right">Members</TableHead>
      <TableHead class="text-right">+24h</TableHead>
      <TableHead class="text-right">Low conf.</TableHead>
      <TableHead>State</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    {#each rows as row (row.groupKey)}
      <TableRow>
        <TableCell>{row.topic || '—'}</TableCell>
        <TableCell class="max-w-xl whitespace-normal">
          <a class={LINK_CLASS} href={groupHref(row.groupKey)}>{row.title}</a>
          <a
            class="ml-1 {MUTED_LINK_CLASS}"
            href={row.ticketUrl}
            target="_blank"
            rel="noreferrer">#{row.foundedTicketId} ↗</a
          >
          {#if row.createdBy === 'seed'}
            <Badge variant="secondary" class="ml-1">seed</Badge>
          {:else if row.createdBy === 'router' || row.createdBy === 'router_no_candidates'}
            <Badge variant="outline" class="ml-1">new</Badge>
          {/if}
          {#if row.topicCount > 1}
            <Badge variant="outline" class="ml-1">{row.topicCount} topics</Badge>
          {/if}
        </TableCell>
        <TableCell class="text-right">{num(row.members)}</TableCell>
        <TableCell class="text-right {row.new24hAlarm ? 'text-amber-300' : ''}">
          {num(row.new24h)}
        </TableCell>
        <TableCell class="text-right">{num(row.lowConfidence)}</TableCell>
        <TableCell>
          {#if row.state === null}
            —
          {:else if row.ruling}
            {GROUP_RULING_LABEL[row.ruling.ruling]}
          {:else}
            <span class="text-dark-2">unruled</span>
          {/if}
        </TableCell>
      </TableRow>
    {/each}
  </TableBody>
</Table>

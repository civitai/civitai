<script lang="ts">
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { num } from '$lib/format';
  import { levelLabel, type AgreementRow } from '$lib/shadow-sexual-prompt';

  let { rows }: { rows: AgreementRow[] } = $props();

  const pct = (part: number, whole: number) =>
    whole ? `${((part / whole) * 100).toFixed(1)}%` : '—';
</script>

{#if rows.length === 0}
  <p class="text-sm text-dark-2">No images scanned in this window.</p>
{:else}
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Level at scan</TableHead>
        <TableHead class="text-right">Fired</TableHead>
        <TableHead class="text-right">Did not fire</TableHead>
        <TableHead class="text-right">Fire rate</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each rows as row (row.level)}
        <TableRow>
          <TableCell class="text-dark-0">{levelLabel(row.level)}</TableCell>
          <TableCell class="text-right tabular-nums">{num(row.fired)}</TableCell>
          <TableCell class="text-right tabular-nums">{num(row.notFired)}</TableCell>
          <TableCell class="text-right tabular-nums text-dark-2">
            {pct(row.fired, row.fired + row.notFired)}
          </TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
{/if}

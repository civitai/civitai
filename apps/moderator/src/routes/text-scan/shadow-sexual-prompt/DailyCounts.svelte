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
  import type { DailyCounts } from '$lib/shadow-sexual-prompt';

  let { rows }: { rows: DailyCounts[] } = $props();

  const COLUMNS = [
    ['scanned', 'Images scanned'],
    ['fired', 'Fires'],
    ['raised', 'Would raise'],
    ['raisedFromPg', 'from PG'],
    ['raisedFromPg13', 'from PG-13'],
    ['raisedFromRPlus', 'from R+'],
    ['raisedFromUnrated', 'from unrated'],
  ] as const;

  const totals = $derived(
    Object.fromEntries(
      COLUMNS.map(([key]) => [key, rows.reduce((sum, r) => sum + r[key], 0)])
    ) as Record<(typeof COLUMNS)[number][0], number>
  );
</script>

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Day (UTC)</TableHead>
      {#each COLUMNS as [key, label] (key)}
        <TableHead class="text-right">{label}</TableHead>
      {/each}
    </TableRow>
  </TableHeader>
  <TableBody>
    {#each rows as row (row.day)}
      <TableRow>
        <TableCell class="font-mono text-xs text-dark-2">{row.day}</TableCell>
        {#each COLUMNS as [key] (key)}
          <TableCell class="text-right tabular-nums {row[key] ? 'text-dark-0' : 'text-dark-2'}">
            {num(row[key])}
          </TableCell>
        {/each}
      </TableRow>
    {/each}
    <TableRow class="font-semibold">
      <TableCell class="text-white">Total</TableCell>
      {#each COLUMNS as [key] (key)}
        <TableCell class="text-right tabular-nums text-white">{num(totals[key])}</TableCell>
      {/each}
    </TableRow>
  </TableBody>
</Table>

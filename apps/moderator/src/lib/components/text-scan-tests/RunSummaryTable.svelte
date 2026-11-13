<script lang="ts">
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import type { RunReport } from '$lib/server/text-scan-tests/reports';
  import { LABEL_NAMES } from '$lib/text-scan-lab/labels';
  import type { LabelSummary } from '$lib/text-scan-tests/score';

  let {
    summary,
    hasBaseline,
    hasDraft,
  }: { summary: RunReport['summary']; hasBaseline: boolean; hasDraft: boolean } = $props();

  const rate = (s: LabelSummary | null) => (s && s.scored ? s.passed / s.scored : null);
  const percent = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

  function detail(s: LabelSummary | null): string {
    if (!s) return '—';
    const head = `${s.passed}/${s.scored} pass`;
    if (s.label === 'nsfw')
      return `${head} · ${s.under} rated lower · ${s.over} rated higher · ${s.offByOne} off by one`;
    return `${head} · ${s.caught} caught · ${s.missed} missed · ${s.falseFlags} false flags`;
  }

  function delta(row: RunReport['summary'][number]): string {
    const before = rate(row.baseline);
    const after = rate(row.draft);
    if (before === null || after === null) return '—';
    const points = Math.round((after - before) * 100);
    return points === 0 ? '±0 pts' : `${points > 0 ? '+' : ''}${points} pts`;
  }
</script>

<div class="rounded-xl border border-dark-4 bg-dark-6">
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Label</TableHead>
        {#if hasBaseline}<TableHead>Baseline</TableHead>{/if}
        {#if hasDraft}<TableHead>Draft</TableHead>{/if}
        {#if hasBaseline && hasDraft}<TableHead>Change</TableHead>{/if}
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each summary as row (row.label)}
        <TableRow>
          <TableCell class="align-top font-medium text-white">{LABEL_NAMES[row.label]}</TableCell>
          {#if hasBaseline}
            <TableCell class="whitespace-normal align-top text-sm text-dark-0">
              <span class="font-semibold">{percent(rate(row.baseline))}</span>
              <span class="block text-xs text-dark-2">{detail(row.baseline)}</span>
            </TableCell>
          {/if}
          {#if hasDraft}
            <TableCell class="whitespace-normal align-top text-sm text-dark-0">
              <span class="font-semibold">{percent(rate(row.draft))}</span>
              <span class="block text-xs text-dark-2">{detail(row.draft)}</span>
            </TableCell>
          {/if}
          {#if hasBaseline && hasDraft}
            <TableCell class="align-top text-sm text-dark-0">{delta(row)}</TableCell>
          {/if}
        </TableRow>
      {:else}
        <TableRow>
          <TableCell class="text-sm text-dark-2">Nothing scored yet.</TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
</div>

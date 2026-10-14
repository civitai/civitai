<script lang="ts">
  import { formatVersions } from '$lib/text-scan-tests/format';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { CHART_PALETTE_SIZE } from '@civitai/ui/components/ui/chart/chart-colors.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { dateTime } from '$lib/format';
  import type { HistoryPoint } from '$lib/server/text-scan-tests/reports';
  import { LABEL_NAMES } from '$lib/text-scan-lab/labels';
  import type { LabLabel } from '$lib/text-scan-lab/types';
  import { LABEL_ORDER } from '$lib/text-scan-tests/expected';

  let { points }: { points: HistoryPoint[] } = $props();

  const SERIES = Object.fromEntries(
    LABEL_ORDER.map((label, i) => [label, `var(--chart-${(i % CHART_PALETTE_SIZE) + 1})`])
  ) as Record<LabLabel, string>;
  const W = 640;
  const H = 220;
  const PAD = { left: 44, right: 120, top: 12, bottom: 12 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  let hover = $state<number | null>(null);
  let asTable = $state(false);

  const labels = $derived(LABEL_ORDER.filter((l) => points.some((p) => p.passRates[l] != null)));
  const slot = $derived(plotW / Math.max(points.length, 1));
  const x = (i: number) =>
    PAD.left + (points.length < 2 ? plotW / 2 : (i * plotW) / (points.length - 1));
  const y = (rate: number) => PAD.top + (1 - rate) * plotH;
  const pct = (rate: number | null | undefined) =>
    rate == null ? '—' : `${Math.round(rate * 100)}%`;
  const versions = (p: HistoryPoint) => formatVersions(p.promptIds);
  const line = (label: LabLabel) =>
    points
      .flatMap((p, i) => {
        const rate = p.passRates[label];
        return rate == null ? [] : [`${x(i)},${y(rate)}`];
      })
      .join(' ');
  const ends = $derived(
    labels.flatMap((label) => {
      for (let i = points.length - 1; i >= 0; i--) {
        const rate = points[i].passRates[label];
        if (rate != null) return [{ label, i, rate }];
      }
      return [];
    })
  );
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5" aria-label="Baseline history">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 class="text-sm font-semibold text-white">Baseline pass rate by prompt version</h2>
    {#if points.length}
      <Button size="xs" variant="ghost" onclick={() => (asTable = !asTable)}>
        {asTable ? 'Show chart' : 'Show table'}
      </Button>
    {/if}
  </div>

  {#if !points.length}
    <p class="mt-2 text-sm text-dark-2">No finished baseline yet.</p>
  {:else if asTable}
    <div class="mt-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Finished</TableHead>
            <TableHead>Versions</TableHead>
            {#each labels as label (label)}
              <TableHead>{LABEL_NAMES[label]}</TableHead>
            {/each}
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each points as p (p.runId)}
            <TableRow class="text-dark-0">
              <TableCell>{dateTime(p.finishedAt)}</TableCell>
              <TableCell class="font-mono text-xs">{versions(p)}</TableCell>
              {#each labels as label (label)}
                <TableCell>{pct(p.passRates[label])}</TableCell>
              {/each}
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
  {:else}
    <ul class="mt-3 flex flex-wrap gap-4 text-xs text-dark-0">
      {#each labels as label (label)}
        <li class="flex items-center gap-1">
          <span class="inline-block h-0.5 w-4" style:background={SERIES[label]}></span>
          {LABEL_NAMES[label]}
        </li>
      {/each}
    </ul>
    <div class="relative mt-2">
      <svg
        viewBox="0 0 {W} {H}"
        class="w-full"
        role="img"
        aria-label="Pass rate per label for each baseline run; the table view lists the same data"
      >
        {#each [0, 0.5, 1] as tick (tick)}
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(tick)}
            y2={y(tick)}
            class="stroke-dark-4"
            stroke-width="1"
          />
          <text x={PAD.left - 6} y={y(tick) + 4} text-anchor="end" class="fill-dark-2 text-[10px]">
            {pct(tick)}
          </text>
        {/each}
        {#if hover !== null}
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            class="stroke-dark-2"
            stroke-width="1"
          />
        {/if}
        {#each labels as label (label)}
          <polyline
            points={line(label)}
            fill="none"
            style:stroke={SERIES[label]}
            stroke-width="2"
            stroke-linejoin="round"
          />
          {#each points as p, i (p.runId)}
            {@const rate = p.passRates[label]}
            {#if rate != null}
              <circle
                cx={x(i)}
                cy={y(rate)}
                r="4"
                style:fill={SERIES[label]}
                class="stroke-dark-6"
                stroke-width="2"
              />
            {/if}
          {/each}
        {/each}
        {#each ends as end (end.label)}
          <text x={x(end.i) + 8} y={y(end.rate) + 4} class="fill-dark-0 text-[10px]">
            {LABEL_NAMES[end.label]} {pct(end.rate)}
          </text>
        {/each}
        {#each points as p, i (p.runId)}
          <rect
            x={x(i) - slot / 2}
            y={PAD.top}
            width={slot}
            height={plotH}
            fill="transparent"
            role="presentation"
            onpointerenter={() => (hover = i)}
            onpointerleave={() => (hover = null)}
          />
        {/each}
      </svg>
      {#if hover !== null}
        {@const p = points[hover]}
        <div
          class={[
            'pointer-events-none absolute top-0 rounded-md border border-dark-4 bg-dark-7 p-2',
            'text-xs text-dark-0',
            x(hover) > W / 2 && '-translate-x-full',
          ]}
          style="left:{(x(hover) / W) * 100}%"
        >
          <p class="text-dark-2">
            {dateTime(p.finishedAt)} · <span class="font-mono">{versions(p)}</span>
          </p>
          {#each labels as label (label)}<p>{LABEL_NAMES[label]}: {pct(p.passRates[label])}</p>{/each}
        </div>
      {/if}
    </div>
  {/if}
</section>

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { ChartData, ChartOptions, Plugin } from 'chart.js';
  import { IconChartLine } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Chart } from '@civitai/ui/components/ui/chart/index.js';
  import { Slider } from '@civitai/ui/components/ui/slider/index.js';
  import { Toggle } from '@civitai/ui/components/ui/toggle/index.js';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import { browser } from '$lib/host';
  import { liveTraceIndex, type EpochTrace } from '$lib/data/trainingRows';
  import { followTrace, traceLossPoints, tracePath } from '$lib/trace';
  import {
    chartPoints,
    clippedRange,
    epochEnds,
    epochMeans,
    formatLoss,
    LEARNING_RATE,
    metricKeys,
    metricSeries,
    recordReadings,
    smoothingAlpha,
    TREND_ALPHA,
    zeroPhaseEma,
    type Reading,
  } from '$lib/loss';

  let { traces, training }: { traces: EpochTrace[]; training: boolean } = $props();

  const metricLabel = (key: string) => (key === LEARNING_RATE ? 'learning rate' : key);

  const readings = new Map<number, Reading>();
  let version = $state(0);
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  function ingest(epoch: number, line: string) {
    const points = traceLossPoints(line);
    if (!points.length) return;
    recordReadings(readings, epoch, points);
    // A finished epoch's trace replays thousands of lines at once; re-deriving the chart per line stalls it.
    flushTimer ??= setTimeout(() => {
      flushTimer = undefined;
      version += 1;
    }, 250);
  }

  const FIRST_LINE_TIMEOUT_MS = 15_000;
  const followers = new Map<string, AbortController>();
  let readStates = $state<Record<string, 'reading' | 'complete' | 'unavailable'>>({});
  // A live tail is whatever this session happened to receive; the finished trace is the record, so
  // a trace tailed live is re-read once its epoch is done.
  const tailedLive = new Set<string>();

  // Read all at once, a long run's later traces sat in the browser's connection queue past
  // FIRST_LINE_TIMEOUT_MS and were marked unavailable unread. Kept under the per-host connection
  // limit.
  const CATCH_UP_READS = 4;
  let freeReads = CATCH_UP_READS;
  const waitingReads: (() => void)[] = [];
  const acquireRead = () =>
    freeReads > 0
      ? (freeReads--, Promise.resolve())
      : new Promise<void>((resolve) => waitingReads.push(resolve));
  const releaseRead = () => {
    const next = waitingReads.shift();
    if (next) next();
    else freeReads++;
  };

  async function follow(path: string) {
    const trace = () => untrack(() => traces).find((t) => tracePath(t.url) === path);
    const epoch = trace()?.epoch ?? -1;
    const live = () => untrack(() => training) && !trace()?.done;
    const controller = new AbortController();
    followers.set(path, controller);
    readStates[path] = 'reading';
    const wasLive = live();
    if (wasLive) tailedLive.add(path);
    else await acquireRead();
    if (controller.signal.aborted) {
      if (!wasLive) releaseRead();
      return;
    }
    // The orchestrator holds a trace request open until its first byte, so the trace of an epoch that
    // never started (a canceled run) would otherwise read forever.
    const stall = wasLive ? undefined : setTimeout(() => controller.abort(), FIRST_LINE_TIMEOUT_MS);
    let failures = 0;
    try {
      const attempt = await followTrace(
        () => trace()?.url ?? path,
        (line) => {
          clearTimeout(stall);
          ingest(epoch, line);
        },
        controller.signal,
        (attempt) => live() || (attempt === 'failed' && ++failures < 3)
      );
      readStates[path] = attempt === 'complete' ? 'complete' : 'unavailable';
    } catch {
      readStates[path] = 'unavailable';
    } finally {
      clearTimeout(stall);
      if (!wasLive) releaseRead();
    }
  }

  const liveIndex = $derived(liveTraceIndex(traces));
  const readable = $derived(liveIndex === -1 ? traces : traces.slice(0, liveIndex + 1));
  const livePath = $derived(training && liveIndex !== -1 ? tracePath(traces[liveIndex].url) : null);
  const catchingUp = $derived(
    readable.filter((t) => tracePath(t.url) !== livePath && readStates[tracePath(t.url)] === 'reading')
      .length
  );
  const unreadable = $derived(
    readable.filter((t) => t.done && readStates[tracePath(t.url)] === 'unavailable').map((t) => t.epoch)
  );

  function retryUnreadable() {
    for (const t of readable) {
      const path = tracePath(t.url);
      if (readStates[path] !== 'unavailable') continue;
      followers.delete(path);
      void follow(path);
    }
  }

  let open = $state(untrack(() => training));

  $effect(() => {
    if (!browser || !open) return;
    const fresh = readable.map((t) => tracePath(t.url)).filter((p) => !followers.has(p));
    const settled = readable
      .map((t) => ({ path: tracePath(t.url), done: t.done }))
      .filter(({ path, done }) => done && tailedLive.has(path) && readStates[path] !== 'reading')
      .map(({ path }) => path);
    untrack(() => {
      fresh.forEach((p) => void follow(p));
      for (const p of settled) {
        // Delete first: follow() writes readStates[p], which this effect read, so the re-run must
        // find the path gone or it reads the trace again.
        tailedLive.delete(p);
        void follow(p);
      }
    });
  });

  let picked = $state<string | null>(null);
  let smoothing = $state(80);
  let showRaw = $state(true);
  let showTrend = $state(true);
  let logScale = $state(false);
  let clipOutliers = $state(true);
  // At zero smoothing the main line already is the raw series.
  const drawRaw = $derived(showRaw && smoothing > 0);

  const sorted = $derived.by(() => {
    void version;
    return [...readings].sort((a, b) => a[0] - b[0]);
  });
  const metrics = $derived(metricKeys(sorted));
  const metric = $derived(picked !== null && metrics.includes(picked) ? picked : (metrics[0] ?? null));
  const series = $derived(
    metric === null ? { xs: [], ys: [], epochs: [] } : metricSeries(sorted, metric, logScale)
  );

  // The EMA leaves ~1e-20 float noise on a flat series (a constant learning rate), and Chart.js would
  // autoscale the axis to that noise.
  const tidy = (ys: number[]) => ys.map((v) => Number(v.toPrecision(6)));
  const smoothed = $derived(tidy(zeroPhaseEma(series.ys, smoothingAlpha(smoothing))));
  const trend = $derived(tidy(zeroPhaseEma(series.ys, TREND_ALPHA)));
  const latest = $derived(
    series.xs.length
      ? { step: series.xs[series.xs.length - 1], value: smoothed[smoothed.length - 1] }
      : null
  );

  const doneEpochs = $derived(traces.filter((t) => t.done).map((t) => t.epoch));
  const markers = $derived(epochEnds(series, doneEpochs));
  const means = $derived(
    metric === null || metric === LEARNING_RATE ? [] : epochMeans(sorted, metric, doneEpochs)
  );

  const FALLBACK_PALETTE = {
    line: '#1971c2',
    trend: '#c1c2c5',
    text: '#8c8fa3',
    grid: '#373a40',
    marker: '#5c5f66',
    surface: '#1a1b1e',
    font: 'ui-sans-serif, system-ui, sans-serif',
  };
  let palette = $state(FALLBACK_PALETTE);
  let panel: HTMLDetailsElement;

  // Chart.js paints a canvas and can't resolve CSS variables, and the embedded element scopes its theme
  // to the element rather than :root — so read the resolved tokens off this panel.
  function readPalette() {
    const css = getComputedStyle(panel);
    const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    palette = {
      line: token('--primary', FALLBACK_PALETTE.line),
      trend: token('--color-dark-0', FALLBACK_PALETTE.trend),
      text: token('--color-dark-2', FALLBACK_PALETTE.text),
      grid: token('--color-dark-4', FALLBACK_PALETTE.grid),
      marker: token('--color-dark-3', FALLBACK_PALETTE.marker),
      surface: token('--color-dark-7', FALLBACK_PALETTE.surface),
      font: css.fontFamily || FALLBACK_PALETTE.font,
    };
  }

  onMount(() => {
    readPalette();
    // An embedding host switches light/dark by toggling a class on an ancestor, at runtime.
    const observer = new MutationObserver(readPalette);
    for (let el = panel.parentElement; el; el = el.parentElement) {
      observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
    return () => {
      observer.disconnect();
      for (const controller of followers.values()) controller.abort();
      clearTimeout(flushTimer);
    };
  });

  function withAlpha(color: string, alpha: number): string {
    const hex = /^#([\da-f]{6})$/i.exec(color);
    if (!hex) return color;
    const n = parseInt(hex[1], 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  const chartData = $derived.by<ChartData<'line'>>(() => {
    const line = {
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: palette.surface,
      tension: 0,
    };
    const raw = withAlpha(palette.line, 0.25);
    // Chart.js paints dataset 0 last, so the smoothed line sits on top of the trend and the raw noise.
    return {
      datasets: [
        {
          ...line,
          label: smoothing > 0 ? 'Smoothed' : 'Value',
          data: chartPoints(series, smoothed),
          borderColor: palette.line,
          backgroundColor: palette.line,
        },
        ...(showTrend
          ? [
              {
                ...line,
                label: 'Trend',
                data: chartPoints(series, trend),
                borderColor: palette.trend,
                backgroundColor: palette.trend,
              },
            ]
          : []),
        ...(drawRaw
          ? [
              {
                ...line,
                borderWidth: 1,
                label: 'Raw',
                data: chartPoints(series, series.ys),
                borderColor: raw,
                backgroundColor: raw,
              },
            ]
          : []),
      ],
    };
  });

  const yRange = $derived.by(() => {
    if (!clipOutliers) return null;
    const shown = [smoothed, ...(showTrend ? [trend] : []), ...(drawRaw ? [series.ys] : [])];
    return clippedRange(shown.flat());
  });

  const chartOptions = $derived.by<ChartOptions<'line'>>(() => {
    const font = { family: palette.font, size: 11 };
    const axis = { color: palette.grid };
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 14 } },
      scales: {
        x: {
          type: 'linear',
          min: series.xs[0],
          max: series.xs[series.xs.length - 1],
          grid: axis,
          border: axis,
          title: { display: true, text: 'Step', color: palette.text, font },
          ticks: {
            color: palette.text,
            font,
            maxTicksLimit: 8,
            callback: (v) => Number(v).toLocaleString(),
          },
        },
        y: {
          type: logScale ? 'logarithmic' : 'linear',
          min: yRange?.min,
          max: yRange?.max,
          grid: axis,
          border: axis,
          ticks: { color: palette.text, font, maxTicksLimit: 6 },
        },
      },
      plugins: {
        legend: {
          position: 'bottom',
          // The toggles above own which series show; a legend click would hide one until the next refresh.
          onClick: () => {},
          labels: { color: palette.text, font, usePointStyle: true, pointStyle: 'line', boxWidth: 18 },
        },
        tooltip: {
          titleFont: font,
          bodyFont: font,
          boxWidth: 12,
          boxHeight: 2,
          multiKeyBackground: 'transparent',
          filter: (item) => Number.isFinite(item.parsed.y),
          callbacks: {
            title: (items) => `Step ${items[0]?.parsed.x.toLocaleString() ?? ''}`,
            label: (item) => ` ${formatLoss(item.parsed.y)}  ${item.dataset.label ?? ''}`,
          },
        },
      },
    };
  });

  // Plugins are fixed when the chart is created, so they read the current marks at draw time.
  const epochMarkers: Plugin<'line'> = {
    id: 'epochMarkers',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = palette.marker;
      ctx.fillStyle = palette.text;
      ctx.font = `11px ${palette.font}`;
      ctx.textBaseline = 'bottom';
      for (const { epoch, step } of markers) {
        const px = scales.x.getPixelForValue(step);
        if (px < chartArea.left || px > chartArea.right) continue;
        const x = Math.round(px) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.textAlign = x > chartArea.right - 24 ? 'right' : 'center';
        ctx.fillText(`E${epoch}`, x, chartArea.top - 2);
      }
      ctx.restore();
    },
  };

  const crosshair: Plugin<'line'> = {
    id: 'lossCrosshair',
    beforeTooltipDraw(chart) {
      const active = chart.tooltip?.getActiveElements();
      if (!active?.length) return;
      const { ctx, chartArea } = chart;
      const x = Math.round(active[0].element.x) + 0.5;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = palette.text;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  const emptyMessage = $derived.by(() => {
    if (training) return 'Loss values appear here as the trainer reports them.';
    if (catchingUp > 0) return 'Reading the training trace…';
    if (unreadable.length) return 'No loss values could be read.';
    return "This run's training trace has no loss values.";
  });
</script>

<details
  bind:this={panel}
  bind:open
  class="overflow-hidden rounded-xl border border-dark-4 bg-dark-6"
>
  <summary
    class="flex select-none items-center gap-2 px-5 py-3 text-sm font-semibold text-dark-0 hover:bg-dark-5/40 [&::-webkit-details-marker]:hidden"
  >
    <IconChartLine size={16} stroke={2} class="text-dark-2" />
    Loss graph
    {#if latest && metric}
      <span class="font-mono text-xs font-normal text-dark-2">
        {metricLabel(metric)} {formatLoss(latest.value)} · step {latest.step.toLocaleString()}
      </span>
    {/if}
  </summary>

  {#if open}
    <div class="border-t border-dark-4 p-5">
      {#if unreadable.length}
        <div class="mb-3 flex flex-wrap items-center gap-2 font-mono text-xs text-red-400">
          Couldn't read the trace for {unreadable.map((e) => `E${e}`).join(', ')}.
          <Button variant="outline" size="sm" onclick={retryUnreadable}>Retry</Button>
        </div>
      {/if}

      {#if series.xs.length < 2}
        <p class="m-0 flex items-center gap-2 text-sm text-dark-2">
          {#if training || catchingUp > 0}
            <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-dark-2"></span>
          {/if}
          {emptyMessage}
        </p>
      {:else}
        <div class="mb-3 flex flex-wrap items-center gap-x-5 gap-y-3">
          {#if metrics.length > 1}
            <ToggleGroup
              type="single"
              bind:value={
                () => metric ?? '',
                (v) => {
                  if (v) picked = v;
                }
              }
              variant="outline"
              size="sm"
            >
              {#each metrics as key (key)}
                <ToggleGroupItem value={key} class="text-xs">{metricLabel(key)}</ToggleGroupItem>
              {/each}
            </ToggleGroup>
          {/if}
          <div class="flex items-center gap-2">
            <span class="font-mono text-xs text-dark-2">Smoothing</span>
            <Slider
              type="single"
              bind:value={smoothing}
              min={0}
              max={99}
              step={1}
              aria-label="Smoothing"
              class="w-32"
            />
            <span class="w-8 font-mono text-xs text-dark-0">{smoothing}%</span>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <Toggle bind:pressed={showRaw} disabled={smoothing === 0} variant="outline" size="sm" class="text-xs">
              Raw
            </Toggle>
            <Toggle bind:pressed={showTrend} variant="outline" size="sm" class="text-xs">Trend</Toggle>
            <Toggle bind:pressed={logScale} variant="outline" size="sm" class="text-xs">Log scale</Toggle>
            <Toggle bind:pressed={clipOutliers} variant="outline" size="sm" class="text-xs">
              Clip outliers
            </Toggle>
          </div>
        </div>

        {#if catchingUp > 0}
          <p class="mb-2 mt-0 font-mono text-xs text-dark-2">
            Reading {catchingUp} more checkpoint trace{catchingUp === 1 ? '' : 's'}…
          </p>
        {/if}

        <div
          role="img"
          aria-label="{metric ? metricLabel(metric) : 'Loss'} by training step"
          class="h-72 rounded-lg border border-dark-4 bg-dark-7 p-2"
        >
          <Chart
            type="line"
            data={chartData}
            options={chartOptions}
            plugins={[epochMarkers, crosshair]}
            class="relative h-full"
          />
        </div>

        <p class="mb-0 mt-2 text-xs text-dark-2">
          Trend is a long moving mean of the raw values. Loss on its own doesn't pick the best checkpoint —
          compare the samples too.
        </p>

        {#if means.length}
          <dl class="mb-0 mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-dark-4 pt-3 font-mono text-xs">
            <dt class="text-dark-2">Mean {metricLabel(metric ?? 'loss')} per checkpoint</dt>
            {#each means as { epoch, mean } (epoch)}
              <dd class="m-0 text-dark-0">
                <span class="text-dark-2">E{epoch}</span> {mean === null ? '—' : formatLoss(mean)}
              </dd>
            {/each}
          </dl>
        {/if}
      {/if}
    </div>
  {/if}
</details>

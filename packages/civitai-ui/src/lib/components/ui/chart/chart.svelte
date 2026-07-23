<script lang="ts">
  import { onMount } from 'svelte';
  import {
    Chart as ChartJS,
    type ChartData,
    type ChartOptions,
    type ChartType,
    type Plugin,
    BarController,
    BarElement,
    CategoryScale,
    Filler,
    Legend,
    LineController,
    LineElement,
    LinearScale,
    PointElement,
    Tooltip,
  } from 'chart.js';

  // Register the tree-shakeable pieces we use (line + bar, category/linear axes, tooltip, legend, area fill).
  // Time axes would additionally need a date adapter — callers pass pre-formatted category labels for now.
  ChartJS.register(
    LineController,
    BarController,
    LineElement,
    PointElement,
    BarElement,
    LinearScale,
    CategoryScale,
    Tooltip,
    Legend,
    Filler
  );

  // Thin, design-system wrapper around Chart.js. SSR renders just the <canvas>; the chart is created in onMount
  // (client only), so there's no canvas/DOM access during SSR. Pass Chart.js `data`/`options` directly; use
  // chartColor()/chartColors() from './chart-colors' for themed series colours.
  let {
    type,
    data,
    options,
    plugins,
    class: className = '',
  }: {
    type: ChartType;
    data: ChartData;
    options?: ChartOptions;
    /** Per-instance Chart.js plugins (e.g. the synced crosshair). Fixed at creation. */
    plugins?: Plugin[];
    class?: string;
  } = $props();

  let canvas: HTMLCanvasElement;
  let chart: ChartJS | undefined;

  onMount(() => {
    chart = new ChartJS(canvas, { type, data, options, plugins });
    return () => chart?.destroy();
  });

  // Reactively push data/option changes to the live chart (no full recreate).
  $effect(() => {
    if (!chart) return;
    chart.data = data;
    if (options) chart.options = options;
    chart.update();
  });
</script>

<div class={className}>
  <canvas bind:this={canvas}></canvas>
</div>

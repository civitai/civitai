<script lang="ts">
  import { Chart, chartColor } from '@civitai/ui/components/ui/chart/index.js';

  // Placeholder series until the owner-keyed rollup (A1) lands — proves the C1 chart primitive renders.
  const labels = Array.from({ length: 14 }, (_, i) => `Jul ${i + 1}`);
  const values = labels.map((_, i) => Math.round(80 + Math.sin(i / 2) * 40 + i * 6));

  const data = {
    labels,
    datasets: [
      {
        label: 'Generations',
        data: values,
        borderColor: chartColor(0),
        backgroundColor: chartColor(0),
        tension: 0.3,
        fill: false,
      },
    ],
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
  };
</script>

<header class="page-header">
  <h1>Analytics</h1>
  <p>How your models are being used — generations and downloads over time.</p>
</header>

<div class="rounded-lg border border-dark-4 bg-dark-6 p-4">
  <p class="mb-3 text-sm text-dark-2">
    Generations over time
    <span class="text-xs text-dark-3">(placeholder data — wires to A1)</span>
  </p>
  <div class="h-64">
    <Chart type="line" {data} {options} class="h-full" />
  </div>
</div>

<p class="placeholder mt-6">
  Real charts wire up once the owner-keyed rollup (A1) lands; the chart primitive (C1) is now in
  <code>@civitai/ui</code>.
</p>

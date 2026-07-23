import type { Chart, Plugin, ActiveElement } from 'chart.js';

// A synced vertical-crosshair plugin. Create ONE instance and pass it to every `<Chart plugins={[crosshair]} />`
// that shares the same category (date) x-axis; hovering any of them draws a vertical line at that x-index on ALL
// of them (Grafana-style) AND (by default) activates each chart's tooltip at that index, so hovering one chart shows
// the value on that date across every chart. Charts self-register on install; the shared state lives in the closure.
//
// Requires the charts to share the same x categories (same labels/length) — index i means the same column on each.
export function createSyncedCrosshair(options?: {
  color?: string;
  lineWidth?: number;
  /** Also drive each chart's tooltip to the hovered index (default true). */
  syncTooltip?: boolean;
}): Plugin {
  const color = options?.color ?? 'rgba(255, 255, 255, 0.25)';
  const lineWidth = options?.lineWidth ?? 1;
  const syncTooltip = options?.syncTooltip ?? true;

  // Shared across every chart this plugin instance is installed on.
  const charts = new Set<Chart>();
  let index: number | null = null;

  // Point each chart's tooltip + active elements at `idx` (or clear if null). The hovered chart is left to Chart.js's
  // native `interaction` handling — we only mirror onto the others.
  function driveTooltip(chart: Chart, idx: number | null) {
    const tooltip = chart.tooltip;
    if (idx == null) {
      chart.setActiveElements([]);
      tooltip?.setActiveElements([], { x: 0, y: 0 });
      return;
    }
    const els: ActiveElement[] = [];
    chart.data.datasets.forEach((_, datasetIndex) => {
      if (!chart.isDatasetVisible(datasetIndex)) return;
      const element = chart.getDatasetMeta(datasetIndex).data[idx];
      if (element) els.push({ datasetIndex, index: idx, element });
    });
    chart.setActiveElements(els);
    const point = els[0]?.element as unknown as { x: number; y: number } | undefined;
    if (tooltip && point) tooltip.setActiveElements(els, { x: point.x, y: point.y });
  }

  const setIndex = (next: number | null, origin?: Chart) => {
    if (next === index) return;
    index = next;
    charts.forEach((c) => {
      // Origin chart: its own line is redrawn by the native hover render; its tooltip is native. Leave it alone.
      if (c === origin) {
        c.draw();
        return;
      }
      if (syncTooltip) {
        driveTooltip(c, next);
        c.update('none'); // re-renders the line (afterDraw) + the mirrored tooltip, no animation
      } else {
        c.draw();
      }
    });
  };

  return {
    id: 'synced-crosshair',
    install(chart) {
      charts.add(chart);
    },
    uninstall(chart) {
      charts.delete(chart);
      if (charts.size === 0) index = null;
    },
    afterEvent(chart, args) {
      const e = args.event;
      if (e.type === 'mouseout') {
        setIndex(null, chart);
        return;
      }
      if (e.x == null) return;
      // Category scale: getValueForPixel returns the (possibly fractional) category index under the cursor.
      const raw = chart.scales.x?.getValueForPixel(e.x);
      if (raw == null || raw < 0) {
        setIndex(null, chart);
        return;
      }
      setIndex(Math.round(raw), chart);
    },
    afterDraw(chart) {
      if (index == null) return;
      const xScale = chart.scales.x;
      if (!xScale) return;
      const x = xScale.getPixelForValue(index);
      const { top, bottom, left, right } = chart.chartArea;
      if (x < left || x > right) return;
      const { ctx } = chart;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.restore();
    },
  };
}

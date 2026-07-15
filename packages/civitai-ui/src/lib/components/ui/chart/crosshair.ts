import type { Chart, Plugin } from 'chart.js';

// A synced vertical-crosshair plugin. Create ONE instance and pass it to every `<Chart plugins={[crosshair]} />`
// that shares the same category (date) x-axis; hovering any of them draws a vertical line at that x-index on ALL
// of them (Grafana-style), because they share the closure state below. Charts self-register on install.
//
// Requires the charts to share the same x categories (same labels/length) — index i means the same column on each.
export function createSyncedCrosshair(options?: { color?: string; lineWidth?: number }): Plugin {
  const color = options?.color ?? 'rgba(255, 255, 255, 0.25)';
  const lineWidth = options?.lineWidth ?? 1;

  // Shared across every chart this plugin instance is installed on.
  const charts = new Set<Chart>();
  let index: number | null = null;

  const setIndex = (next: number | null) => {
    if (next === index) return;
    index = next;
    // Redraw every synced chart so each re-runs afterDraw with the new index. draw() doesn't emit events, so this
    // can't re-enter the afterEvent handler that called it.
    charts.forEach((c) => c.draw());
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
        setIndex(null);
        return;
      }
      if (e.x == null) return;
      // Category scale: getValueForPixel returns the (possibly fractional) category index under the cursor.
      const raw = chart.scales.x?.getValueForPixel(e.x);
      if (raw == null || raw < 0) {
        setIndex(null);
        return;
      }
      setIndex(Math.round(raw));
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

import type { ChartOptions } from 'chart.js';

/** Truncate a string with an ellipsis if it exceeds `max` characters. */
export const truncateLabel = (text: string, max: number) =>
  text.length > max ? text.slice(0, max - 1) + '…' : text;

/** Format a numeric tick value as abbreviated (1K, 2.5M, etc.). Returns '' for 0. */
export const abbreviateValue = (value: number | string): string => {
  const num = Number(value);
  if (num === 0) return '';
  if (num >= 1_000_000)
    return `${(num / 1_000_000).toFixed(num % 1_000_000 === 0 ? 0 : 1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(num % 1_000 === 0 ? 0 : 1)}K`;
  return num.toString();
};

/**
 * Shared scale defaults for Buzz dashboard charts.
 *
 * Usage: spread into your chart options and override what you need.
 *
 * ```ts
 * const options = {
 *   ...chartScaleDefaults({ labelColor, mobile }),
 *   // your overrides
 * };
 * ```
 */
export function chartScaleDefaults({
  labelColor,
  mobile,
}: {
  labelColor: string;
  mobile: boolean;
}): Pick<ChartOptions, 'scales'> {
  return {
    scales: {
      x: {
        ticks: {
          color: labelColor,
          maxTicksLimit: mobile ? 5 : 8,
          autoSkip: true,
        },
        grid: { display: false },
      },
      y: {
        beginAtZero: true,
        ticks: {
          color: labelColor,
          callback: abbreviateValue,
        },
        grid: { color: 'rgba(128, 128, 128, 0.1)' },
      },
    },
  };
}

/**
 * Shared tooltip defaults: centered, clean layout matching the Buzz dashboard style.
 */
export function chartTooltipDefaults({
  accentColor,
  formatValue,
  maxTitleLength = 28,
}: {
  accentColor?: string;
  formatValue?: (value: number) => string;
  maxTitleLength?: number;
} = {}): NonNullable<ChartOptions['plugins']>['tooltip'] {
  return {
    position: 'nearest',
    xAlign: 'right',
    yAlign: 'center',
    displayColors: false,
    padding: 12,
    titleFont: { size: 13, weight: 600 },
    titleAlign: 'center',
    bodyFont: { size: 20, weight: 'bold' },
    ...(accentColor ? { bodyColor: accentColor } : {}),
    bodyAlign: 'center',
    footerFont: { size: 12, weight: 500 },
    footerAlign: 'center',
    callbacks: {
      title(tooltipItems) {
        const label = tooltipItems[0].dataset.label ?? '';
        return truncateLabel(label, maxTitleLength);
      },
      footer(tooltipItems) {
        const raw = tooltipItems[0].parsed.x;
        // If x-axis is a time value (number), format as date
        if (typeof raw === 'number' && raw > 1_000_000_000) {
          return new Date(raw).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });
        }
        return String(tooltipItems[0].label ?? '');
      },
      label(tooltipItem) {
        const val = tooltipItem.parsed.y ?? 0;
        return formatValue ? formatValue(val) : val.toLocaleString();
      },
    },
  };
}

/**
 * Shared legend defaults: small rounded boxes, theme-aware color, hidden on mobile.
 */
export function chartLegendDefaults({
  labelColor,
  mobile,
  maxLabelLength = 40,
}: {
  labelColor: string;
  mobile: boolean;
  maxLabelLength?: number;
}): ChartOptions['plugins'] {
  return {
    legend: {
      display: !mobile,
      labels: {
        boxWidth: 10,
        boxHeight: 10,
        borderRadius: 5,
        useBorderRadius: true,
        color: labelColor,
        ...(maxLabelLength > 0
          ? {
              generateLabels: (chart) => {
                const defaults =
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (chart.constructor as any).defaults?.plugins?.legend?.labels?.generateLabels?.(
                    chart
                  ) ?? [];
                return defaults.map(
                  (label: { text?: string; [key: string]: unknown }) => ({
                    ...label,
                    text: truncateLabel(label.text ?? '', maxLabelLength),
                  })
                );
              },
            }
          : {}),
      },
    },
    title: { display: false },
  };
}

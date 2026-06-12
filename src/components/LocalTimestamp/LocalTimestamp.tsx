import { Tooltip } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { DiscordTimestampStyle } from '~/utils/timestamp-helpers';
import {
  DEFAULT_TIMESTAMP_STYLE,
  formatDiscordTimestamp,
  normalizeTimestampStyle,
} from '~/utils/timestamp-helpers';

type Props = {
  /** Unix timestamp in seconds. */
  value: number | string;
  style?: DiscordTimestampStyle | string;
  className?: string;
};

/**
 * Renders a Discord-style `<t:UNIX:STYLE>` timestamp in the viewer's local
 * timezone. To avoid hydration mismatches, the first render (server + client)
 * uses a timezone-stable UTC string; after mount we swap to the visitor's
 * local time. A tooltip always shows the full local date/time on hover.
 */
export function LocalTimestamp({ value, style, className }: Props) {
  const seconds = typeof value === 'string' ? parseInt(value, 10) : value;
  const resolvedStyle: DiscordTimestampStyle = normalizeTimestampStyle(style);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!Number.isFinite(seconds)) return null;

  const display = formatDiscordTimestamp(seconds, resolvedStyle, { utc: !mounted });
  const fullLabel = formatDiscordTimestamp(seconds, 'F', { utc: !mounted });
  const iso = new Date(seconds * 1000).toISOString();

  return (
    <Tooltip label={fullLabel} withArrow withinPortal>
      <time
        dateTime={iso}
        data-type="timestamp"
        data-value={seconds}
        data-style={resolvedStyle}
        suppressHydrationWarning
        className={className}
        style={{
          backgroundColor: 'var(--mantine-color-blue-light)',
          borderRadius: 4,
          padding: '0 4px',
          whiteSpace: 'nowrap',
        }}
      >
        {display}
      </time>
    </Tooltip>
  );
}

LocalTimestamp.defaultStyle = DEFAULT_TIMESTAMP_STYLE;

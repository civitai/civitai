import { Paper, Progress, Text } from '@mantine/core';
import clsx from 'clsx';
import {
  describeUsageLimit,
  usageAreaName,
  windowCaption,
  type UsageLimitRow,
  type UsageLimitTone,
} from '~/components/Account/usage/usage-limit-view';

const BAR_COLOR: Record<UsageLimitTone, string> = {
  ok: 'blue',
  warn: 'orange',
  full: 'red',
  exempt: 'gray',
};

/** One area's limits: a header with the window, then a row per limit. */
export function UsageLimitCard({
  area,
  rows,
  now,
  timeZone,
}: {
  area: string;
  rows: UsageLimitRow[];
  now: number;
  timeZone?: string;
}) {
  const caption = windowCaption(rows);
  return (
    <Paper withBorder radius="md" data-testid={`usage-area-${area}`}>
      <div className="flex items-center justify-between gap-2 border-b border-gray-3 px-4 py-2.5 dark:border-dark-4">
        <Text fw={600} size="sm">
          {usageAreaName(area)}
        </Text>
        {caption && (
          <Text size="xs" c="dimmed">
            {caption}
          </Text>
        )}
      </div>
      {rows.map((row) => (
        <UsageLimitRowView key={row.id} row={row} now={now} timeZone={timeZone} />
      ))}
    </Paper>
  );
}

function UsageLimitRowView({
  row,
  now,
  timeZone,
}: {
  row: UsageLimitRow;
  now: number;
  timeZone?: string;
}) {
  const view = describeUsageLimit(row, { now, timeZone });
  return (
    <div
      className={clsx(
        'grid items-center gap-x-3 gap-y-1.5 border-b border-gray-3 px-4 py-2.5 last:border-b-0 dark:border-dark-4',
        'grid-cols-[1fr_auto] [grid-template-areas:"name_when""bar_bar"]',
        'sm:grid-cols-[1.3fr_1.6fr_0.9fr] sm:[grid-template-areas:"name_bar_when"]'
      )}
    >
      <Text size="sm" fw={600} className="[grid-area:name]">
        {row.label}
      </Text>
      <div className="[grid-area:bar]">
        {view.percent !== null && (
          <Progress
            value={view.percent}
            color={BAR_COLOR[view.tone]}
            size="sm"
            radius="xl"
            aria-label={`${row.label}: ${view.usedText}`}
          />
        )}
        <Text size="xs" c="dimmed" mt={4}>
          {view.usedText}
        </Text>
      </div>
      <div className="text-right [grid-area:when]">
        {view.when && (
          <Text size="sm" fw={600}>
            {view.when}
          </Text>
        )}
        {view.whenDetail && (
          <Text size="xs" c="dimmed">
            {view.whenDetail}
          </Text>
        )}
      </div>
    </div>
  );
}

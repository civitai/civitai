import { Badge, Loader, SegmentedControl, Skeleton, Text, Tooltip } from '@mantine/core';
import clsx from 'clsx';
import { useMemo } from 'react';
import type { SchedulePerDay } from '@civitai/shared/post-scheduling';
import { utcDayKey } from '@civitai/shared/post-scheduling';
import { formatDate } from '~/utils/date-helpers';

export type PreviewView = 'strips' | 'list';

export type PreviewPost = { title: string | null; publishedAt: Date };

const MAX_DOTS = 7;
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export function dayElementId(day: string) {
  return `batch-day-${day}`;
}

type MonthStrip = {
  label: string;
  leadingBlanks: number;
  days: { day: string; dayOfMonth: number }[];
};

function monthStrips(perDay: SchedulePerDay[]): MonthStrip[] {
  if (!perDay.length) return [];
  const first = new Date(`${perDay[0].day}T00:00:00Z`);
  const last = new Date(`${perDay[perDay.length - 1].day}T00:00:00Z`);
  const strips: MonthStrip[] = [];
  const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
  while (cursor <= last) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    strips.push({
      label: formatDate(cursor, 'MMM YYYY', true),
      leadingBlanks: (cursor.getUTCDay() + 6) % 7,
      days: Array.from({ length: daysInMonth }, (_, i) => ({
        day: utcDayKey(new Date(Date.UTC(year, month, i + 1))),
        dayOfMonth: i + 1,
      })),
    });
    cursor.setUTCMonth(month + 1);
  }
  return strips;
}

export function badgeColor(total: number, dailyLimit: number | null) {
  if (dailyLimit === null) return 'gray';
  if (total > dailyLimit) return 'red';
  if (total === dailyLimit) return 'yellow';
  return 'gray';
}

export function SchedulePreview({
  posts,
  perDay,
  dailyLimit,
  view,
  onViewChange,
  loading,
  highlightDay,
}: {
  posts: PreviewPost[];
  perDay: SchedulePerDay[];
  dailyLimit: number | null;
  view: PreviewView;
  onViewChange?: (view: PreviewView) => void;
  loading?: boolean;
  highlightDay?: string | null;
}) {
  const byDay = useMemo(() => new Map(perDay.map((entry) => [entry.day, entry])), [perDay]);
  const strips = useMemo(() => monthStrips(perDay), [perDay]);

  return (
    <div className="flex flex-col gap-2" data-testid="batch-preview">
      <div className="flex items-center justify-between gap-2">
        <Text size="sm" fw={600}>
          Preview
        </Text>
        <div className="flex items-center gap-2">
          {loading && <Loader size="xs" />}
          {onViewChange && (
            <SegmentedControl
              size="xs"
              value={view}
              onChange={(value) => onViewChange(value as PreviewView)}
              data={[
                { value: 'strips', label: 'Months' },
                { value: 'list', label: 'List' },
              ]}
            />
          )}
        </div>
      </div>
      {loading && !perDay.length ? (
        <div className="flex flex-col gap-2">
          <Skeleton height={90} />
          <Text size="xs" c="dimmed">
            Checking your existing schedule…
          </Text>
        </div>
      ) : !posts.length ? (
        <Text size="sm" c="dimmed">
          Add media to see when your posts would go live.
        </Text>
      ) : view === 'list' ? (
        <PostList posts={posts} />
      ) : (
        <div className="flex flex-col gap-3">
          {strips.map((strip) => (
            <div key={strip.label} className="flex flex-col gap-1">
              <Text size="xs" fw={600} c="dimmed">
                {strip.label}
              </Text>
              <div className="grid grid-cols-7 gap-px">
                {WEEKDAYS.map((weekday, index) => (
                  <Text key={index} size="xs" c="dimmed" ta="center">
                    {weekday}
                  </Text>
                ))}
                {Array.from({ length: strip.leadingBlanks }, (_, i) => (
                  <div key={`blank-${i}`} />
                ))}
                {strip.days.map(({ day, dayOfMonth }) => {
                  const entry = byDay.get(day);
                  const total = (entry?.incoming ?? 0) + (entry?.existing ?? 0);
                  return (
                    <DayCell
                      key={day}
                      day={day}
                      dayOfMonth={dayOfMonth}
                      incoming={entry?.incoming ?? 0}
                      existing={entry?.existing ?? 0}
                      color={badgeColor(total, dailyLimit)}
                      highlighted={highlightDay === day}
                    />
                  );
                })}
              </div>
            </div>
          ))}
          <Text size="xs" c="dimmed">
            Days and counts are UTC days, which is how the daily limit is counted. Times in the list
            are your local time. Filled dots are this batch; hollow dots are posts you already have
            scheduled.
          </Text>
        </div>
      )}
    </div>
  );
}

function DayCell({
  day,
  dayOfMonth,
  incoming,
  existing,
  color,
  highlighted,
}: {
  day: string;
  dayOfMonth: number;
  incoming: number;
  existing: number;
  color: string;
  highlighted: boolean;
}) {
  const total = incoming + existing;
  const dots = Math.min(MAX_DOTS, total);
  const filled = Math.min(dots, incoming);
  return (
    <Tooltip
      label={`${formatDate(
        new Date(`${day}T00:00:00Z`),
        'ddd MMM D',
        true
      )} (UTC): ${incoming} in this batch${existing ? `, ${existing} already scheduled` : ''}`}
      disabled={!total}
      withinPortal
    >
      <div
        id={dayElementId(day)}
        className={clsx(
          'flex min-h-[44px] flex-col items-center gap-0.5 rounded px-0.5 py-1 text-xs',
          total ? 'bg-gray-1 dark:bg-dark-6' : 'text-gray-5 dark:text-dark-3',
          highlighted && 'ring-2 ring-blue-5'
        )}
        data-day={day}
        data-count={total || undefined}
      >
        <span>{dayOfMonth}</span>
        {total > 0 && (
          <>
            <span className="flex max-w-full flex-wrap justify-center gap-px">
              {Array.from({ length: dots }, (_, i) => (
                <span
                  key={i}
                  className={clsx(
                    'size-1.5 rounded-full',
                    i < filled ? 'bg-blue-5' : 'border border-gray-6 dark:border-gray-4'
                  )}
                />
              ))}
              {total > MAX_DOTS && (
                <span className="text-[10px] leading-none">+{total - MAX_DOTS}</span>
              )}
            </span>
            <Badge size="xs" variant="light" color={color} px={4}>
              {total}
            </Badge>
          </>
        )}
      </div>
    </Tooltip>
  );
}

function PostList({ posts }: { posts: PreviewPost[] }) {
  return (
    <div className="max-h-[320px] overflow-auto rounded border border-gray-2 dark:border-dark-5">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-gray-0 text-left text-xs text-gray-6 dark:bg-dark-7 dark:text-gray-4">
          <tr>
            <th className="px-2 py-1 font-medium">#</th>
            <th className="px-2 py-1 font-medium">Title</th>
            <th className="px-2 py-1 font-medium">Date</th>
            <th className="px-2 py-1 font-medium">Time</th>
          </tr>
        </thead>
        <tbody data-testid="batch-preview-list">
          {posts.map((post, index) => (
            <tr key={index} className="border-t border-gray-2 dark:border-dark-5">
              <td className="px-2 py-1 text-gray-6 dark:text-gray-4">{index + 1}</td>
              <td className="max-w-[160px] truncate px-2 py-1">{post.title ?? <i>Untitled</i>}</td>
              <td className="whitespace-nowrap px-2 py-1">
                {formatDate(post.publishedAt, 'ddd MMM D')}
              </td>
              <td className="whitespace-nowrap px-2 py-1" data-testid="batch-preview-time">
                {formatDate(post.publishedAt, 'h:mm A')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

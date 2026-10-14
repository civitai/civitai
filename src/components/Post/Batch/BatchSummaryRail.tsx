import { Button, Drawer, Text, UnstyledButton } from '@mantine/core';
import { IconAlertTriangle, IconChevronUp, IconWand } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import type { ScheduleIssue, SchedulePerDay } from '@civitai/shared/post-scheduling';
import { formatDate } from '~/utils/date-helpers';
import type { PreviewPost, PreviewView } from './SchedulePreview';
import { SchedulePreview } from './SchedulePreview';

export type BatchSummaryRailProps = {
  variant: 'desktop' | 'mobile';
  totals: { uploaded: number; eligible: number; posts: number; excluded: number };
  first: Date | null;
  last: Date | null;
  cadence: string;
  issues: ScheduleIssue[];
  checking: boolean;
  dailyLimit: number | null;
  perDay: SchedulePerDay[];
  posts: PreviewPost[];
  onIssueClick: (issue: ScheduleIssue) => void;
  highlightDay: string | null;
  canFixSpacing: boolean;
  onFixSpacing: () => void;
  fixSummary: string | null;
  onReview: () => void;
  reviewDisabledReason: string | null;
  view: PreviewView;
  onViewChange: (view: PreviewView) => void;
};

export function BatchSummaryRail(props: BatchSummaryRailProps) {
  if (props.variant === 'mobile') return <MobileRail {...props} />;
  return (
    <aside
      className="hidden h-fit flex-col gap-4 rounded-lg border border-gray-2 bg-gray-0 p-4 lg:sticky lg:top-[calc(var(--header-height)+16px)] lg:flex dark:border-dark-5 dark:bg-dark-7"
      aria-label="Summary"
      data-testid="batch-summary-rail"
    >
      <Totals {...props} />
      <Issues {...props} />
      <SchedulePreview
        posts={props.posts}
        perDay={props.perDay}
        dailyLimit={props.dailyLimit}
        view={props.view}
        onViewChange={props.onViewChange}
        loading={props.checking}
        highlightDay={props.highlightDay}
      />
      <ReviewAction {...props} />
    </aside>
  );
}

function Totals({ totals, first, last, cadence }: BatchSummaryRailProps) {
  return (
    <div className="flex flex-col gap-0.5" data-testid="batch-totals">
      <Text fw={600}>
        {totals.eligible} {totals.eligible === 1 ? 'image' : 'images'} → {totals.posts}{' '}
        {totals.posts === 1 ? 'post' : 'posts'}
      </Text>
      {totals.excluded > 0 && (
        <Text size="sm" c="dimmed">
          {totals.eligible} of {totals.uploaded} will be posted.
        </Text>
      )}
      {first && last && (
        <>
          <Text size="sm">First: {formatDate(first, 'ddd MMM D, h:mm A')}</Text>
          <Text size="sm">Last: {formatDate(last, 'ddd MMM D, h:mm A')}</Text>
          <Text size="sm" c="dimmed">
            {cadence}
          </Text>
        </>
      )}
    </div>
  );
}

function Issues({
  issues,
  onIssueClick,
  canFixSpacing,
  onFixSpacing,
  fixSummary,
}: BatchSummaryRailProps) {
  if (!issues.length && !fixSummary) return null;
  const shown = issues.slice(0, 6);
  return (
    <div className="flex flex-col gap-1" data-testid="batch-issues">
      {shown.map((issue, index) => (
        <UnstyledButton
          key={`${issue.code}-${issue.index ?? issue.day ?? index}`}
          onClick={() => onIssueClick(issue)}
          className="flex items-start gap-1 text-left text-sm text-red-7 hover:underline dark:text-red-4"
        >
          <IconAlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{issue.message}</span>
        </UnstyledButton>
      ))}
      {issues.length > shown.length && (
        <Text size="xs" c="dimmed">
          and {issues.length - shown.length} more
        </Text>
      )}
      {canFixSpacing && (
        <Button
          size="compact-sm"
          variant="light"
          leftSection={<IconWand size={14} />}
          onClick={onFixSpacing}
          className="self-start"
        >
          Fix spacing automatically
        </Button>
      )}
      {fixSummary && (
        <Text size="xs" c="dimmed">
          {fixSummary}
        </Text>
      )}
    </div>
  );
}

function ReviewAction({ onReview, reviewDisabledReason, totals }: BatchSummaryRailProps) {
  return (
    <div className="flex flex-col gap-1">
      <Button
        onClick={onReview}
        disabled={!!reviewDisabledReason}
        fullWidth
        data-testid="batch-review-button"
      >
        Review {totals.posts} {totals.posts === 1 ? 'post' : 'posts'}
      </Button>
      <Text size="xs" c={reviewDisabledReason ? 'red' : 'dimmed'} ta="center">
        {reviewDisabledReason ?? 'Nothing is posted until you confirm on the next screen.'}
      </Text>
    </div>
  );
}

function MobileRail(props: BatchSummaryRailProps) {
  const [opened, setOpened] = useState(false);
  const { totals, first, last, issues } = props;
  const range =
    first && last ? ` · ${formatDate(first, 'MMM D')} – ${formatDate(last, 'MMM D')}` : '';
  const conflicts = issues.length
    ? ` · ${issues.length} ${issues.length === 1 ? 'conflict' : 'conflicts'}`
    : '';
  return (
    <>
      <UnstyledButton
        onClick={() => setOpened(true)}
        className={clsx(
          'fixed inset-x-0 bottom-[var(--footer-height,0px)] z-40 flex items-center justify-between gap-2 border-t border-gray-2 bg-gray-0 px-4 py-3 text-sm lg:hidden dark:border-dark-5 dark:bg-dark-7',
          issues.length && 'text-red-7 dark:text-red-4'
        )}
        aria-label="Open summary"
      >
        <span>
          {totals.posts} {totals.posts === 1 ? 'post' : 'posts'}
          {range}
          {conflicts}
        </span>
        <IconChevronUp size={18} />
      </UnstyledButton>
      <Drawer
        opened={opened}
        onClose={() => setOpened(false)}
        position="bottom"
        size="85%"
        title="Summary"
      >
        {/* The theme gives every Drawer body `overflow: hidden`, so the sheet scrolls here. */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-4">
          <Totals {...props} />
          <Issues {...props} />
          <SchedulePreview
            posts={props.posts}
            perDay={props.perDay}
            dailyLimit={props.dailyLimit}
            view="list"
            loading={props.checking}
          />
          <ReviewAction
            {...props}
            onReview={() => {
              setOpened(false);
              props.onReview();
            }}
          />
        </div>
      </Drawer>
    </>
  );
}

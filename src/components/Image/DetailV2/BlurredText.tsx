import { Badge } from '@mantine/core';
import clsx from 'clsx';

/** Stands in for a text item the viewer has not revealed: the text stays out of the page, not just out of sight. */
export function BlurredText({ className }: { className?: string }) {
  return (
    <div
      className={clsx('flex flex-col gap-3 blur-sm', className)}
      aria-hidden
      data-testid="text-blurred"
    >
      {[92, 100, 84, 96, 60].map((width, i) => (
        <div
          key={i}
          className="h-3 rounded bg-gray-3 dark:bg-dark-4"
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  );
}

/**
 * Unscanned text reaches only its author and moderators (the reader read leaves it out for
 * everyone else); it says so until the scan lands.
 */
export function TextPendingReview({ nsfwLevel }: { nsfwLevel: number }) {
  if (nsfwLevel) return null;
  return (
    <Badge
      color="yellow"
      variant="light"
      size="sm"
      className="mb-3"
      data-testid="text-pending-review"
    >
      Pending review
    </Badge>
  );
}

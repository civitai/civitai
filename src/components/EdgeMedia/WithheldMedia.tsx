import { IconPhotoOff } from '@tabler/icons-react';
import clsx from 'clsx';

/**
 * Stands in for an image the server sent without its media (`url` null): a block withholds it.
 * `compact` drops the label, for a thumbnail too small to hold it.
 */
export function WithheldMedia({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <div
      className={clsx(
        'flex size-full flex-col items-center justify-center gap-1 bg-gray-2 text-sm text-dark-2 dark:bg-dark-6',
        !compact && 'min-h-32',
        className
      )}
    >
      <IconPhotoOff size={compact ? 20 : 32} stroke={1.5} />
      {!compact && <span>Media unavailable</span>}
    </div>
  );
}

import { IconPhotoOff } from '@tabler/icons-react';
import clsx from 'clsx';

/** Stands in for an image the server sent without its media (`url` null): a block withholds it. */
export function WithheldMedia({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        'flex size-full min-h-32 flex-col items-center justify-center gap-1 bg-gray-2 text-sm text-dark-2 dark:bg-dark-6',
        className
      )}
    >
      <IconPhotoOff size={32} stroke={1.5} />
      <span>Media unavailable</span>
    </div>
  );
}

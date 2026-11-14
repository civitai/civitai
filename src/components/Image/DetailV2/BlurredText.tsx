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

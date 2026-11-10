import { IconCheck } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';

/** One choice in a sheet: a 48px row, checked when it is the current value. */
export function SheetOption({
  selected,
  disabled,
  onClick,
  role,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  role?: 'option' | 'menuitemradio';
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-selected={role === 'option' ? selected : undefined}
      aria-checked={role === 'menuitemradio' ? selected : undefined}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'flex min-h-12 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-base',
        'disabled:opacity-50',
        selected ? 'bg-blue-0 dark:bg-dark-5' : 'active:bg-gray-1 dark:active:bg-dark-6'
      )}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {selected && <IconCheck size={18} className="shrink-0 text-blue-6" />}
    </button>
  );
}

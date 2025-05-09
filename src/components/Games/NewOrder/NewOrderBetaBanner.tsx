import { IconX } from '@tabler/icons-react';
import { useState } from 'react';

export function NewOrderBetaBanner() {
  const [isVisible, setIsVisible] = useState(true);

  if (!isVisible) return null;

  return (
    <div className="absolute inset-x-0 top-0 z-50 flex items-start justify-between bg-gradient-to-r from-amber-600 to-amber-500 px-4 py-2 text-white shadow-md">
      <div className="flex flex-col items-start gap-2 @md:flex-row">
        <span className="rounded-md bg-white px-1.5 py-0.5 text-xs font-bold text-amber-600 sm:inline">
          BETA
        </span>
        <p className="text-sm font-medium sm:text-base">
          This is the first release of Knights of New Order. Mechanics, rewards, and progression
          systems are subject to change as we gather feedback and refine the experience.
        </p>
      </div>
      <button
        onClick={() => setIsVisible(false)}
        className="ml-2 rounded-full p-1 transition-colors hover:bg-white/20"
        aria-label="Dismiss beta notification"
      >
        <IconX className="size-4" />
      </button>
    </div>
  );
}

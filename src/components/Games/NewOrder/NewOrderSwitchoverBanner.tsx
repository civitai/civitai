import { IconX } from '@tabler/icons-react';
import { useState } from 'react';

// Left empty, the banner renders without a link so a placeholder URL never ships.
export const KNIGHTS_V2_ARTICLE_URL = '';

export function NewOrderSwitchoverBanner() {
  const [isVisible, setIsVisible] = useState(true);

  if (!isVisible) return null;

  return (
    <div className="absolute inset-x-0 top-0 z-50 flex items-start justify-between bg-gradient-to-r from-amber-600 to-amber-500 px-4 py-2 text-white shadow-md">
      <div className="flex flex-col items-start gap-2 @md:flex-row">
        <span className="rounded-md bg-white px-1.5 py-0.5 text-xs font-bold text-amber-600 sm:inline">
          V2
        </span>
        <p className="text-sm font-medium sm:text-base">
          Knights v2 is coming on Tuesday 11/17.{' '}
          {KNIGHTS_V2_ARTICLE_URL ? (
            <a
              href={KNIGHTS_V2_ARTICLE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-white underline"
            >
              Here&apos;s what changes
            </a>
          ) : (
            <>Here&apos;s what changes</>
          )}
        </p>
      </div>
      <button
        onClick={() => setIsVisible(false)}
        className="ml-2 rounded-full p-1 transition-colors hover:bg-white/20"
        aria-label="Dismiss Knights v2 notification"
      >
        <IconX className="size-4" />
      </button>
    </div>
  );
}

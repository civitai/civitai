import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';

/** The author's caption on the image being read. Mount it keyed on the image so it folds on a swipe. */
export function StorylineCaptionNote({ caption }: { caption: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

  // Only an overflowing caption opens: one that fits would open to the same text.
  useEffect(() => {
    const el = textRef.current;
    if (!el || open) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [caption, open]);

  const interactive = overflows || open;
  const toggle = () => interactive && setOpen((value) => !value);

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={interactive ? open : undefined}
      data-mantine-stop-propagation={open || undefined}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
        } else if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
      className={clsx(
        'relative w-full rounded-2xl px-3.5 py-2.5 text-left text-[15px] leading-[21px] @md:w-[560px] @md:max-w-full',
        'bg-white/95 text-gray-9 shadow-[0_8px_24px_rgba(0,0,0,.3)] ring-1 ring-gray-3/70 backdrop-blur-md',
        'dark:bg-dark-6/95 dark:text-white dark:ring-dark-4/70',
        interactive &&
          'cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-4'
      )}
      data-testid="storyline-caption-note"
    >
      <div
        ref={textRef}
        className={clsx(
          'whitespace-pre-line break-words',
          open
            ? 'max-h-[45vh] overflow-y-auto overscroll-contain pb-5 pr-2'
            : 'line-clamp-2 @md:line-clamp-3'
        )}
      >
        {caption}
      </div>
      {interactive && (
        <span
          className={clsx(
            'text-[var(--mantine-color-violet-7)] dark:text-[var(--mantine-color-violet-4)] absolute bottom-2.5 right-3.5 pl-11 text-sm font-bold',
            'bg-gradient-to-r from-transparent to-white to-50% dark:to-dark-6'
          )}
          aria-hidden
        >
          {open ? 'less' : 'more'}
        </span>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { ActionIcon } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import clsx from 'clsx';

export function TwScrollX({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const largerThanViewport = node && node.scrollWidth > node.offsetWidth;
  const [position, setPosition] = useState<'start' | 'end' | null>(null);

  useEffect(() => {
    if (!node) return;

    function scroll() {
      if (!node) return;
      if (node.scrollLeft === 0) setPosition('start');
      else if (node.scrollLeft >= node.scrollWidth - node.offsetWidth - 1) setPosition('end');
      else setPosition(null);
    }
    scroll();

    const observer = new MutationObserver(scroll);

    observer.observe(node, { subtree: true, childList: true });
    node?.addEventListener('scroll', scroll, { passive: true });
    return () => {
      observer.disconnect();
      node?.removeEventListener('scroll', scroll);
    };
  }, [node]);

  const scrollLeft = () => node?.scrollBy({ left: -200, behavior: 'smooth' });
  const scrollRight = () => node?.scrollBy({ left: 200, behavior: 'smooth' });

  return (
    <div className={clsx('relative ')} {...props}>
      {largerThanViewport && position !== 'start' && (
        <div className="absolute inset-y-0 left-0 z-10 flex items-center bg-white/50 transition hover:bg-white dark:bg-dark-7/50 hover:dark:bg-dark-7">
          <ActionIcon variant="transparent" radius={0} onClick={scrollLeft} className="h-full">
            <IconChevronLeft stroke={2.5} size={28} />
          </ActionIcon>
        </div>
      )}
      <div ref={setNode} className={clsx('overflow-x-auto scrollbar-none', className)}>
        {children}
      </div>
      {largerThanViewport && position !== 'end' && (
        <div className="absolute inset-y-0 right-0 z-10 flex items-center bg-white/50 transition hover:bg-white dark:bg-dark-7/50 hover:dark:bg-dark-7">
          <ActionIcon variant="transparent" radius={0} onClick={scrollRight} className="h-full">
            <IconChevronRight stroke={2.5} size={28} />
          </ActionIcon>
        </div>
      )}
    </div>
  );
}

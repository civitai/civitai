import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { isMobileDevice } from '~/hooks/useIsMobile';

export function TwScrollX({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [largerThanViewport, setLargerThanViewport] = useState(false);
  const [position, setPosition] = useState<'start' | 'end' | null>(null);

  useEffect(() => {
    if (!node) return;

    function update() {
      if (!node) return;
      setLargerThanViewport(node.scrollWidth > node.offsetWidth);
      if (node.scrollLeft === 0) setPosition('start');
      else if (node.scrollLeft >= node.scrollWidth - node.offsetWidth - 1) setPosition('end');
      else setPosition(null);
    }

    update();

    const mutationObserver = new MutationObserver(update);
    const resizeObserver = new ResizeObserver(update);

    mutationObserver.observe(node, { subtree: true, childList: true });
    resizeObserver.observe(node);
    node?.addEventListener('scroll', update, { passive: true });
    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      node?.removeEventListener('scroll', update);
    };
  }, [node]);

  const scrollLeft = () => node?.scrollBy({ left: -200, behavior: 'smooth' });
  const scrollRight = () => node?.scrollBy({ left: 200, behavior: 'smooth' });
  const isMobile = isMobileDevice();

  return (
    <div className={clsx('relative overflow-hidden')} {...props}>
      {largerThanViewport && position !== 'start' && (
        <div
          className={clsx(
            'absolute inset-y-0 left-0 z-10 flex items-center bg-gradient-to-r from-white from-60% to-transparent dark:from-dark-7',
            { ['hidden']: isMobile }
          )}
        >
          <LegacyActionIcon
            variant="subtle"
            radius={0}
            onClick={scrollLeft}
            className="h-full"
          >
            <IconChevronLeft stroke={2.5} size={28} />
          </LegacyActionIcon>
        </div>
      )}
      <div ref={setNode} className={clsx('overflow-x-auto scrollbar-none', className)}>
        {children}
      </div>
      {largerThanViewport && position !== 'end' && (
        <div
          className={clsx(
            'absolute inset-y-0 right-0 z-10 flex items-center bg-gradient-to-l from-white from-60% to-transparent dark:from-dark-7',
            { ['hidden']: isMobile }
          )}
        >
          <LegacyActionIcon
            variant="subtle"
            radius={0}
            onClick={scrollRight}
            className="h-full"
          >
            <IconChevronRight stroke={2.5} size={28} />
          </LegacyActionIcon>
        </div>
      )}
    </div>
  );
}

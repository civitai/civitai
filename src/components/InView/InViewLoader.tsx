import type { CSSProperties } from 'react';
import React, { useEffect, useState } from 'react';
import { useInView, type IntersectionOptions } from 'react-intersection-observer';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';

export function InViewLoader({
  children,
  loadFn,
  loadCondition,
  loadTimeout = 500,
  className,
  style,
  inViewOptions,
}: {
  children: React.ReactNode;
  loadFn: () => unknown | Promise<unknown>;
  loadCondition: boolean;
  loadTimeout?: number;
  className?: string;
  style?: CSSProperties;
  inViewOptions?: IntersectionOptions;
}) {
  const scrollAreaRef = useScrollAreaRef();
  const { ref, inView } = useInView({ root: scrollAreaRef?.current, rootMargin: '400px 0px' });
  const [initialCanLoad, setInitialCanLoad] = useState(false);
  const [canLoad, setCanLoad] = useState(true);

  useEffect(() => {
    setTimeout(() => {
      setInitialCanLoad(true);
    }, 1500);
  }, []);

  useEffect(() => {
    if (inView && loadCondition && initialCanLoad && canLoad) {
      const handleLoad = async () => {
        await loadFn();
        setTimeout(() => setCanLoad(true), loadTimeout);
      };

      setCanLoad(false);
      handleLoad();
    }
  }, [inView, loadCondition, initialCanLoad, canLoad]); // eslint-disable-line

  return (
    <div ref={ref} className={className} style={{ minHeight: 36, ...style }}>
      {inView && children}
    </div>
  );
}

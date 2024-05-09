import React, { CSSProperties, useEffect, useState } from 'react';
import { IntersectionOptions } from 'react-intersection-observer';
import { useInView } from '~/hooks/useInView';

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
  const { ref, inView } = useInView({ rootMargin: '1200px 0px', ...inViewOptions });
  const [initialCanLoad, setInitialCanLoad] = useState(false);
  const [canLoad, setCanLoad] = useState(true);

  useEffect(() => {
    setTimeout(() => {
      setInitialCanLoad(true);
    }, loadTimeout);
  }, [loadTimeout]);

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
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}

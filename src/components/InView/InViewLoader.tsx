import React, { CSSProperties, useEffect, useState } from 'react';
import { useInView } from '~/hooks/useInView';

export function InViewLoader({
  children,
  loadFn,
  loadCondition,
  loadTimeout = 500,
  className,
  style,
}: {
  children: React.ReactNode;
  loadFn: () => any | Promise<any>;
  loadCondition: boolean;
  loadTimeout?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const { ref, inView } = useInView();
  const [canLoad, setCanLoad] = useState(false);

  useEffect(() => {
    setTimeout(() => {
      setCanLoad(true);
    }, loadTimeout);
  }, [loadTimeout]);

  useEffect(() => {
    if (inView && loadCondition && canLoad) {
      const handleLoad = async () => {
        await loadFn();
        setTimeout(() => setCanLoad(true), loadTimeout);
      };

      setCanLoad(false);
      handleLoad();
    }
  }, [inView, loadCondition]); // eslint-disable-line

  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}

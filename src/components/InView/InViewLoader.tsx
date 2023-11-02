import React, { useEffect, useState } from 'react';
import { useInView } from 'react-intersection-observer';

export function InViewLoader({
  children,
  loadFn,
  loadCondition,
  loadTimeout = 500,
}: {
  children: React.ReactNode;
  loadFn: () => void;
  loadCondition: boolean;
  loadTimeout?: number;
}) {
  const { ref, inView } = useInView();
  const [canLoad, setCanLoad] = useState(true);

  useEffect(() => {
    if (inView && loadCondition && canLoad) {
      setCanLoad(false);
      loadFn();
      setTimeout(() => setCanLoad(true), loadTimeout);
    }
  }, [inView, loadCondition]); // eslint-disable-line

  return <div ref={ref}>{children}</div>;
}

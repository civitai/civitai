import React, { useRef, Suspense, Fragment, useEffect } from 'react';

interface StorageRef {
  promise?: Promise<void>;
  resolve?: (value: void | PromiseLike<void>) => void;
}

function Suspender({ freeze, children }: { freeze: boolean; children: React.ReactNode }) {
  const promiseCache = useRef<StorageRef>({}).current;
  if (freeze && !promiseCache.promise) {
    promiseCache.promise = new Promise((resolve) => {
      promiseCache.resolve = resolve;
    });
    throw promiseCache.promise;
  } else if (freeze) {
    throw promiseCache.promise;
  } else if (promiseCache.promise) {
    promiseCache.resolve!();
    promiseCache.promise = undefined;
  }

  return (
    <Fragment>
      <DontHideMeBro data-frozen={freeze}>{children}</DontHideMeBro>
    </Fragment>
  );
}

function DontHideMeBro({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== 'attributes' || mutation.attributeName !== 'style') continue;
        const target = mutation.target as HTMLElement;
        if (target.getAttribute('style')?.includes('display: none !important;'))
          target.setAttribute('style', '');
      }
    });

    observer.observe(ref.current, {
      attributes: true,
      attributeFilter: ['style'],
    });

    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return <span ref={ref}>{children}</span>;
}

interface Props {
  freeze: boolean;
  children: React.ReactNode;
}

export function Freeze({ freeze, children }: Props) {
  return (
    <Suspense>
      <Suspender freeze={freeze}>{children}</Suspender>
    </Suspense>
  );
}

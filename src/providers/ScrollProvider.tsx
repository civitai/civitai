import Router from 'next/router';
import React, { cloneElement, useEffect, useRef } from 'react';

import { createKeyDebouncer } from '~/utils/debouncer';
import { EventEmitter } from '~/utils/eventEmitter';
import { ExponentialBackoff } from '~/utils/exponentialBackoff';

type ScrollPosition = { scrollTop: number; scrollLeft: number };
const scrollMap = new Map<string, ScrollPosition>();

const debounce = createKeyDebouncer(300);

const emitter = new EventEmitter<{ scroll: ScrollPosition & { key: string } }>();
emitter.on('scroll', ({ key, ...scrollPosition }) => {
  debounce(key, () => scrollMap.set(key, scrollPosition));
});

export const useScrollPosition = () => {
  useEffect(() => {
    let canEmit = true;
    const node = document.querySelector('html');
    if (typeof window !== 'undefined') history.scrollRestoration = 'manual';

    const handleRouteChangeComplete = () => {
      canEmit = false;
      const backoff = new ExponentialBackoff({
        startingDelay: 50,
        growthFactor: 1,
        maxAttempts: 10,
        onMaxAttemptsReached: () => {
          canEmit = true;
        },
      });
      backoff.execute(() => {
        const record = scrollMap.get(history.state.key);
        if (record && node) {
          // console.log(window.innerHeight, record?.scrollTop, node?.scrollTop);
          if (node.scrollTop === record.scrollTop && node.scrollLeft === record.scrollLeft) {
            backoff.abort();
            canEmit = true;
            return;
          }

          node.scrollTop = record.scrollTop;
          node.scrollLeft = record.scrollLeft;
        }
      });
    };

    const handleScroll = () => {
      if (node && canEmit) {
        emitter.emit('scroll', {
          key: history.state.key,
          scrollTop: node.scrollTop,
          scrollLeft: node.scrollLeft,
        });
      }
    };

    addEventListener('scroll', handleScroll);
    Router.events.on('routeChangeComplete', handleRouteChangeComplete);
    return () => {
      removeEventListener('scroll', handleScroll);
      Router.events.off('routeChangeComplete', handleRouteChangeComplete);
    };
  }, []);
};

export function ScrollProvider({ children }: { children: React.ReactElement }) {
  const ref = useRef<HTMLElement>();
  console.log(ref.current);

  return cloneElement(children, { ref });
}

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

export const useScrollRestore = () => {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
  });
};

export const useWindowScrollRestore = () => {
  useEffect(() => {
    let routeChangeComplete = false;
    const node = document.querySelector('html');
    if (typeof window !== 'undefined') history.scrollRestoration = 'manual';
    let backoff: ExponentialBackoff | undefined;

    const handleRouteChangeComplete = () => {
      routeChangeComplete = true;
      backoff = new ExponentialBackoff({
        startingDelay: 50,
        growthFactor: 1,
        maxAttempts: 10,
      });
      backoff.execute(() => {
        const record = scrollMap.get(history.state.key);
        if (record && node) {
          if (node.scrollTop === record.scrollTop && node.scrollLeft === record.scrollLeft) {
            backoff?.abort();
            return;
          }

          node.scrollTop = record.scrollTop;
          node.scrollLeft = record.scrollLeft;
        }
      });
    };

    const handleScroll = () => {
      if (node) {
        if (routeChangeComplete && node.scrollTop === 0 && node?.scrollLeft === 0) {
          routeChangeComplete = false;
        } else {
          backoff?.abort();
          emitter.emit('scroll', {
            key: history.state.key,
            scrollTop: node.scrollTop,
            scrollLeft: node.scrollLeft,
          });
        }
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

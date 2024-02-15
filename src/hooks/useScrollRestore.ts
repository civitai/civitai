import { useResizeObserver } from '~/hooks/useResizeObserver';
import { useCallback, useEffect, useRef, useState } from 'react';

import { createKeyDebouncer } from '~/utils/debouncer';
import { EventEmitter } from '~/utils/eventEmitter';

type ScrollPosition = {
  scrollTop: number;
  scrollLeft: number;
};

export type UseScrollRestoreProps = {
  key?: string;
  enabled?: boolean;
};

const scrollMap = new Map<string, ScrollPosition>();
const debounce = createKeyDebouncer(300);

export const useScrollRestore = <T extends HTMLElement = any>(args?: UseScrollRestoreProps) => {
  const { key, enabled = true } = args ?? {};

  // #region [refs]
  const emitterRef = useRef(new EventEmitter<{ scroll: ScrollPosition & { key: string } }>());
  const manualScrolledRef = useRef(false);
  const ignoreScrollRef = useRef(false);
  const restoredRef = useRef(false);
  const mountTimeRef = useRef(new Date());
  // #endregion

  const defaultKey =
    typeof window !== 'undefined'
      ? `${history.state.key}_${location.pathname.substring(1)}`
      : 'default';
  const _key = key ?? defaultKey;

  // #region [scroll emitter]
  useEffect(() => {
    const node = ref.current;
    const emitter = emitterRef.current;
    if (!enabled || !emitter || !node) return;
    const cb = emitter.on('scroll', ({ key, ...curr }) =>
      debounce(key, () => scrollMap.set(key, curr))
    );
    return () => emitter.off('scroll', cb);
  }, [enabled]);
  // #endregion

  useEffect(() => {
    const node = ref.current;
    if (!node || !enabled) return;

    manualScrolledRef.current = false;
    ignoreScrollRef.current = true;
    restoredRef.current = false;
    mountTimeRef.current = new Date();

    const record = scrollMap.get(_key);
    if (!record) {
      node.scrollTop = 0;
      node.scrollLeft = 0;
    }

    const handleScroll = () => {
      if (ignoreScrollRef.current) {
        ignoreScrollRef.current = false;
      } else {
        manualScrolledRef.current = true;
        emitterRef.current.emit('scroll', {
          key: _key,
          scrollTop: node.scrollTop,
          scrollLeft: node.scrollLeft,
        });
      }
    };

    node.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      node.removeEventListener('scroll', handleScroll);
    };
  }, [_key, enabled]); //eslint-disable-line

  const restore = useCallback(() => {
    const node = ref.current;
    if (manualScrolledRef.current || !node) return;

    const record = scrollMap.get(_key);

    if (!record || (node.scrollTop === record.scrollTop && node.scrollLeft === record.scrollLeft)) {
      restoredRef.current = true;
      return;
    }

    ignoreScrollRef.current = true;
    node.scrollTop = record.scrollTop;
    node.scrollLeft = record.scrollLeft;
  }, [_key]);

  // TODO - determine a way to unobserve children after scroll restore
  const ref = useResizeObserver<T>(
    () => {
      if (restoredRef.current) return;
      const now = new Date();
      if (mountTimeRef.current.getTime() + 5000 > now.getTime()) {
        restore();
      }
    },
    { observeChildren: true }
  );

  return ref;
};

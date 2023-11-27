import { useCallback, useEffect, useRef } from 'react';

import { createKeyDebouncer } from '~/utils/debouncer';
import { EventEmitter } from '~/utils/eventEmitter';

type ScrollPosition = { scrollTop: number; scrollLeft: number };
const scrollMap = new Map<string, ScrollPosition>();

const debounce = createKeyDebouncer(300);

export type UseScrollRestoreProps = {
  key?: string;
  defaultPosition?: 'top' | 'bottom';
  enabled?: boolean;
};

export const getScrollAreaKey = (key?: string) =>
  `${key ?? history.state.key}_${location.pathname.substring(1)}`;

export const useScrollRestore = <T extends HTMLElement = any>(args?: UseScrollRestoreProps) => {
  const { key, defaultPosition = 'top', enabled = true } = args ?? {};
  const ref = useRef<T>(null);
  const emitterRef = useRef(new EventEmitter<{ scroll: ScrollPosition & { key: string } }>());
  const ignoreScrollRef = useRef(false);

  useEffect(() => {
    const emitter = emitterRef.current;
    if (!enabled || !emitter) return;
    const cb = emitter.on('scroll', ({ key, ...scrollPosition }) =>
      debounce(key, () => scrollMap.set(key, scrollPosition))
    );
    return () => emitter.off('scroll', cb);
  }, [enabled]);

  useEffect(() => {
    const node = ref.current;
    if (!node || !enabled) return;
    const _key = getScrollAreaKey(key);
    const record = scrollMap.get(_key);
    ignoreScrollRef.current = true;
    if (!record) {
      switch (defaultPosition) {
        case 'top': {
          if (node.scrollTop !== 0) node.scrollTop = 0;
          break;
        }
        case 'bottom': {
          const scrollBottom = node.scrollHeight - node.clientHeight;
          if (node.scrollTop < scrollBottom) node.scrollTop = scrollBottom;
          break;
        }
      }
    } else {
      node.scrollTop = record.scrollTop;
      node.scrollLeft = record.scrollLeft;
    }

    const handleScroll = () => {
      if (ignoreScrollRef.current) {
        ignoreScrollRef.current = false;
      } else {
        emitterRef.current.emit('scroll', {
          key: _key,
          scrollTop: node.scrollTop,
          scrollLeft: node.scrollLeft,
        });
      }
    };

    node.addEventListener('scroll', handleScroll);
    return () => {
      node.removeEventListener('scroll', handleScroll);
    };
  }, [key, defaultPosition, enabled]); //eslint-disable-line

  const restore = useCallback(() => {
    const node = ref.current;
    const _key = getScrollAreaKey(key);
    const record = scrollMap.get(_key);
    if (!node || !record) return;
    ignoreScrollRef.current = true;
    node.scrollTop = record.scrollTop;
    node.scrollLeft = record.scrollLeft;
  }, [key]);

  return { ref, restore };
};

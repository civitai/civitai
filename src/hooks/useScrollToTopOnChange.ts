import { useEffect, useRef } from 'react';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';

/**
 * Scrolls the page's scroll area back to the top whenever `key` changes, so a new search starts
 * at its best match instead of swapping results in place under the viewer. Never on mount: a
 * page restored from history keeps its scroll position.
 */
export function useScrollToTopOnChange(key: string | undefined) {
  const scrollRef = useScrollAreaRef();
  const previousKey = useRef(key);

  useEffect(() => {
    if (previousKey.current === key) return;
    previousKey.current = key;
    const node = scrollRef?.current;
    if (node) node.scrollTo({ top: 0 });
    else window.scrollTo({ top: 0 });
  }, [key, scrollRef]);
}

import { Textarea, type TextareaProps } from '@mantine/core';
import { forwardRef, useCallback, useRef, useState } from 'react';

/**
 * Drop-in replacement for Mantine's Textarea that correctly recalculates
 * autosize height when the textarea's width changes (e.g. sidebar toggle,
 * container resize). Mantine uses react-textarea-autosize which only
 * recalculates on re-renders and window resize — not container width changes.
 */
export const AutosizeTextarea = forwardRef<HTMLTextAreaElement, TextareaProps>((props, ref) => {
  const [, forceResize] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const lastWidthRef = useRef<number>(0);

  const callbackRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      // Forward to external ref
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;

      // Clean up previous observer
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      if (node) {
        lastWidthRef.current = node.offsetWidth;
        observerRef.current = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const newWidth = entry.contentRect.width;
            if (newWidth !== lastWidthRef.current) {
              lastWidthRef.current = newWidth;
              forceResize((c) => c + 1);
            }
          }
        });
        observerRef.current.observe(node);
      }
    },
    [ref, forceResize]
  );

  return <Textarea {...props} ref={callbackRef} />;
});

AutosizeTextarea.displayName = 'AutosizeTextarea';

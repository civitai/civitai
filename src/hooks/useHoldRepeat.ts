import { useEffect, useRef } from 'react';
import type { MouseEvent, PointerEvent } from 'react';

/** Button handlers that run `onStep` once on press, then repeat it while the press is held. */
export function useHoldRepeat(onStep: () => void, { delay = 400, interval = 80 } = {}) {
  const latest = useRef(onStep);
  latest.current = onStep;
  const timers = useRef<{
    wait?: ReturnType<typeof setTimeout>;
    repeat?: ReturnType<typeof setInterval>;
  }>({});

  const stop = () => {
    clearTimeout(timers.current.wait);
    clearInterval(timers.current.repeat);
    timers.current = {};
  };

  useEffect(() => stop, []);

  return {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      stop();
      latest.current();
      timers.current.wait = setTimeout(() => {
        timers.current.repeat = setInterval(() => latest.current(), interval);
      }, delay);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    // Enter and Space fire a click with no pointer press (`detail` 0); a pointer press already stepped.
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      if (e.detail === 0) latest.current();
    },
    onContextMenu: (e: MouseEvent<HTMLButtonElement>) => e.preventDefault(),
  };
}

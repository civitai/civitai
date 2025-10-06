import { useCallback, useEffect, useRef } from 'react';

export class PausableInterval {
  private intervalMs: number;
  private callback: () => void;
  private timeoutId: NodeJS.Timeout | null = null;
  private remainingMs: number;
  private startTime: number | null = null;
  private isRunning = false;

  constructor(callback: () => void, intervalMs: number) {
    this.callback = callback;
    this.intervalMs = intervalMs;
    this.remainingMs = intervalMs;
  }

  start(nested?: boolean) {
    if (!nested && this.isRunning) return;

    this.isRunning = true;
    this.startTime = Date.now();
    this.timeoutId = setTimeout(() => {
      this.callback();
      this.remainingMs = this.intervalMs;
      this.start(true); // Restart for next interval
    }, this.remainingMs);
  }

  pause() {
    if (!this.isRunning) return;

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    if (this.startTime !== null) {
      const elapsed = Date.now() - this.startTime;
      this.remainingMs = Math.max(0, this.remainingMs - elapsed);
    }

    this.isRunning = false;
    this.startTime = null;
  }

  stop() {
    this.pause();
    this.remainingMs = this.intervalMs;
  }

  get isActive(): boolean {
    return this.isRunning;
  }
}

export function usePausableInterval(
  callback: () => void,
  intervalMs: number,
  options?: { autoStart?: boolean }
) {
  // const [active, setActive] = useState(false);
  const timerRef = useRef<PausableInterval | null>(null);
  const callbackRef = useRef(callback);

  // Keep callback ref updated
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const start = useCallback(() => {
    timerRef.current?.start();
  }, []);

  const pause = useCallback(() => {
    timerRef.current?.pause();
  }, []);

  const stop = useCallback(() => {
    timerRef.current?.stop();
  }, []);

  // Initialize timer
  useEffect(() => {
    timerRef.current = new PausableInterval(() => callbackRef.current(), intervalMs);

    if (options?.autoStart) {
      start();
    }

    return () => {
      stop();
      timerRef.current = null;
    };
  }, [intervalMs, options?.autoStart, start, stop]);

  return { pause, start, stop };
}

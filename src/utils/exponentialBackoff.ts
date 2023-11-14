type BackoffOptions<T = any> = {
  startingDelay: number;
  growthFactor: number;
  maxAttempts: number;
  maxDelay?: number;
  delayFirstAttempt?: boolean;
  resolve?: (data: T) => boolean;
  retry: (e: any, attemptNumber: number) => boolean | Promise<boolean>;
  onMaxAttemptsReached?: () => void;
};

const defaultOptions: BackoffOptions = {
  startingDelay: 100,
  growthFactor: 2,
  maxAttempts: 5,
  retry: () => true,
};

const sanitizeOptions = <T>(options: Partial<BackoffOptions<T>> = {}) => {
  const sanitized = { ...defaultOptions, ...options };

  if (sanitized.maxAttempts < 1) {
    sanitized.maxAttempts = 1;
  }

  return sanitized;
};

export class ExponentialBackoff<T = any> {
  private attemptNumber = 0;
  private options: BackoffOptions<T>;
  private delay: number;
  private timeout?: NodeJS.Timeout;

  private get attemptLimitReached() {
    return this.attemptNumber >= this.options.maxAttempts || !this.timeout;
  }

  private increment = () => {
    const { startingDelay, growthFactor, maxDelay } = this.options;
    this.attemptNumber++;
    this.delay = (this.delay === 0 ? startingDelay : this.delay) * growthFactor;
    if (maxDelay && this.delay > maxDelay) this.delay = maxDelay;
  };

  constructor(options: Partial<BackoffOptions<T>>) {
    const sanitized = sanitizeOptions(options);
    this.options = sanitized;
    this.delay = sanitized.delayFirstAttempt ? sanitized.startingDelay : 0;
  }

  execute = (cb: () => Promise<T> | T) => {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = setTimeout(async () => {
      this.increment();
      try {
        const data = await cb();
        const resolved = this.options.resolve?.(data) ?? false;
        if (resolved) this.attemptNumber = 0;
        else if (!this.attemptLimitReached) this.execute(cb);
        else this.options.onMaxAttemptsReached?.();
      } catch (e) {
        const shouldRetry = !this.attemptLimitReached && this.options.retry(e, this.attemptNumber);
        if (shouldRetry) this.execute(cb);
      }
    }, this.delay);
  };

  abort = () => {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
      this.attemptNumber = 0;
    }
  };
}

// export async function incrementalBackoff<T>(cb: () => Promise<T> | T, options?: BackoffOptions<T>) {
//   const { startingDelay, growthFactor, maxAttempts, maxDelay, delayFirstAttempt, resolve, retry } =
//     sanitizeOptions(options);

//   let attemptNumber = 0;
//   let timeout = delayFirstAttempt ? startingDelay : 0;

//   const attemptLimitReached = () => attemptNumber >= maxAttempts;

//   const increment = () => {
//     attemptNumber++;
//     timeout = (timeout === 0 ? startingDelay : timeout) * growthFactor;
//     if (maxDelay && timeout > maxDelay) timeout = maxDelay;
//   };

//   while (!attemptLimitReached()) {
//     try {
//       await delay(timeout);
//       const data = await cb();
//       if (resolve?.(data)) attemptNumber = maxAttempts;
//       increment();
//     } catch (e) {
//       increment();
//       const shouldRetry = await retry(e, attemptNumber);

//       if (!shouldRetry || attemptLimitReached()) {
//         throw e;
//       }
//     }
//   }
// }

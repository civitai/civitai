import { createDebouncer } from '~/utils/debouncer';

export class TaskBatcher<T> {
  private batched: any[] = [];
  private debouncer: ReturnType<typeof createDebouncer>;
  private callback: ((batched: T[]) => void) | undefined;

  configure = ({ callback }: { callback: (batched: T[]) => void }) => {
    this.callback = callback;
  };

  batch = <T>(args: T) => {
    const cb = this.callback;
    if (!cb) throw new Error('TaskBatcher error: callback not defined');
    this.batched.push(args);
    this.debouncer(() => {
      const arr = [...this.batched];
      this.batched = [];
      cb(arr);
    });
  };

  constructor(delay: number) {
    this.debouncer = createDebouncer(delay);
  }
}

export class TaskBatcherIntervals<T> {
  private interval: number;
  private maxAttempts?: number;
  private taskBatcher: TaskBatcher<T>;
  private dictionary: Record<string, { interval: NodeJS.Timeout; attempts: number }> = {};

  configure = ({ callback }: { callback: (batched: T[]) => void }) => {
    this.taskBatcher.configure({ callback });
  };

  add = (id: string, args: T) => {
    if (!this.dictionary[id])
      this.dictionary[id] = {
        attempts: 0,
        interval: setInterval(() => {
          this.dictionary[id].attempts++;
          this.taskBatcher.batch(args);

          if (this.maxAttempts && this.maxAttempts <= this.dictionary[id].attempts) {
            this.remove(id);
          }
        }, this.interval),
      };
  };

  remove = (id: string) => {
    const current = this.dictionary[id];
    if (current) clearInterval(current.interval);
    delete this.dictionary[id];
  };

  reset = () => {
    for (const key in this.dictionary) this.remove(key);
  };

  constructor(args: { interval: number; delay: number; maxAttempts?: number }) {
    this.taskBatcher = new TaskBatcher<T>(args.delay);
    this.interval = args.interval;
    this.maxAttempts = args.maxAttempts;
  }
}

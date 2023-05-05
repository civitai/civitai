const max_pending_promises = 1;

/** obsolete */
export default class QueueOld {
  static queue: any[] = [];
  static nb_pending_promises = 0;

  static enqueue<T>(promise: () => Promise<T>) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        promise,
        resolve,
        reject,
      });
      this.dequeue();
    });
  }

  static dequeue() {
    // If max pending promises is reached, return
    if (this.nb_pending_promises >= max_pending_promises) {
      return false;
    }

    const item = this.queue.shift();
    if (item) {
      // Try to perform the next promise
      try {
        this.nb_pending_promises++;
        item
          .promise()
          .then((value: unknown) => {
            item.resolve(value);
          })
          .catch((err: unknown) => {
            item.reject(err);
          });
      } catch (err) {
        item.reject(err);
      } finally {
        // In all cases: decrement and try to perform the next promise
        this.nb_pending_promises--;
        this.dequeue();
      }
    }
  }
}

// https://charemza.name/blog/posts/javascript/async/javascript-queue-with-concurrency-limit/
type Task<T = unknown> = () => Promise<T>;
export class Queue {
  private _concurrency = Infinity;
  private _tasks: Task[] = [];
  private _running = 0;

  constructor(concurrency?: number) {
    if (concurrency) this._concurrency = concurrency;
  }

  /** can only dequeue tasks that haven't started */
  dequeue = <T>(task: Task<T>) => {
    const index = this._tasks.indexOf(task);
    if (index > -1) this._tasks.splice(index, 1);
  };

  enqueu = async <T>(task: Task<T>, concurrencyOverride?: number) => {
    const concurrency = concurrencyOverride ?? this._concurrency;
    this._tasks.push(task);
    if (this._running >= concurrency) return;

    ++this._running;
    while (this._tasks.length) {
      try {
        const pendingTask = this._tasks.shift();
        await pendingTask?.();
      } catch (err) {
        console.error(err);
      }
    }
    --this._running;
  };
}

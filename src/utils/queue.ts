const max_pending_promises = 1;

export default class Queue {
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

type Task = () => Promise<void>;
export function limitConcurrency(tasks: Task[], limit: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let active = 0;
    let finished = 0;
    let index = 0;

    const checkFinished = () => {
      if (finished === tasks.length) resolve();
    };

    const run = async () => {
      if (index === tasks.length) return;

      const currentIndex = index;
      index++;

      active++;
      try {
        await tasks[currentIndex]();
      } catch (error) {
        reject(error);
        return;
      }
      active--;
      finished++;

      checkFinished();

      if (active < limit) run(); // Start a new task if we're below the concurrency limit
    };

    // Start the initial set of tasks
    for (let i = 0; i < Math.min(limit, tasks.length); i++) {
      run();
    }
  });
}

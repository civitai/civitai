export type Task = () => Promise<void>;
type TaskGenerator = () => Task | null;

function isTaskGenerator(arg: any): arg is TaskGenerator {
  return typeof arg === 'function';
}

type LimitConcurrencyOptions = {
  limit: number;
  betweenTasksFn?: () => Promise<void>;
};
export function limitConcurrency(
  tasksOrGenerator: Task[] | TaskGenerator,
  options?: LimitConcurrencyOptions | number
): Promise<void> {
  if (typeof options === 'number') options = { limit: options } as LimitConcurrencyOptions;
  if (!options) options = { limit: 1 } as LimitConcurrencyOptions;
  const { limit, betweenTasksFn } = options;

  return new Promise((resolve, reject) => {
    let active = 0;
    let finished = false;
    let index = 0;
    const isGenerator = isTaskGenerator(tasksOrGenerator);
    const tasks = isGenerator ? [] : (tasksOrGenerator as Task[]);

    const getNextTask = async (): Promise<Task | null> => {
      if (betweenTasksFn) await betweenTasksFn();
      if (isGenerator) return tasksOrGenerator();
      else {
        if (index < tasks.length) return tasks[index++];
        return null;
      }
    };

    const checkFinished = () => {
      if (finished && active === 0) resolve();
    };

    const run = async () => {
      const task = await getNextTask();
      if (!task) {
        finished = true;
        checkFinished();
        return;
      }

      active++;
      try {
        await task();
      } catch (error) {
        reject(error);
        return;
      } finally {
        active--;
        checkFinished();
        if (active < limit && !finished) run(); // Start a new task if we're below the concurrency limit
      }
    };

    // Start the initial set of tasks
    for (let i = 0; i < limit; i++) run();
  });
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

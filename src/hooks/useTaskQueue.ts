import React from 'react';

// https://gist.github.com/tomhicks/95d455186fadda2f7d99e6163aa9d360
export function useTaskQueue(params: { shouldProcess: boolean }): {
  tasks: ReadonlyArray<Task>;
  isProcessing: boolean;
  addTask: (task: Task) => void;
} {
  const [queue, setQueue] = React.useState<{
    isProcessing: boolean;
    tasks: Array<Task>;
  }>({ isProcessing: false, tasks: [] });

  React.useEffect(() => {
    if (!params.shouldProcess) return;
    if (queue.tasks.length === 0) return;
    if (queue.isProcessing) return;

    const task = queue.tasks[0];
    setQueue((prev) => ({
      isProcessing: true,
      tasks: prev.tasks.slice(1),
    }));

    Promise.resolve(task()).finally(() => {
      setQueue((prev) => ({
        isProcessing: false,
        tasks: prev.tasks,
      }));
    });
  }, [queue, params.shouldProcess]);

  return {
    tasks: queue.tasks,
    isProcessing: queue.isProcessing,
    addTask: React.useCallback((task) => {
      setQueue((prev) => ({
        isProcessing: prev.isProcessing,
        tasks: [...prev.tasks, task],
      }));
    }, []),
  };
}

type Task = () => Promise<void> | void;

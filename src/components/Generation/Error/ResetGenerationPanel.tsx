import { Button, Title } from '@mantine/core';
import { generationGraphStore } from '~/store/generation-graph.store';

export function ResetGenerationPanel({ onResetClick }: { onResetClick?: VoidFunction }) {
  const handleReset = () => {
    generationGraphStore.clearData();
    onResetClick?.();
  };

  return (
    <div className="flex size-full flex-col items-center justify-center p-2">
      <div className="mb-5 flex flex-col items-center">
        <div className="overflow-hidden rounded-xl shadow">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/media/whoops.jpg"
            alt="something went wrong"
            className="w-full max-w-[200px]"
          />
        </div>
        <br />
        <Title order={3}>{`Something went wrong :(`}</Title>
        <Button
          onClick={() => {
            const keys = Object.keys(localStorage).filter((key) =>
              key.startsWith('generation-form')
            );
            for (const key of keys) {
              localStorage.removeItem(key);
            }
            handleReset();
          }}
        >
          Reset Generator State
        </Button>
      </div>
    </div>
  );
}

import { Loader, Text } from '@mantine/core';

export function PageLoader({ text }: { text?: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <Loader />
      {text && <Text>{text}</Text>}
    </div>
  );
}

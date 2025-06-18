import { Loader, Text } from '@mantine/core';
import clsx from 'clsx';

export function PageLoader({ text, className }: { text?: string; className?: string }) {
  return (
    <div className={clsx(className, 'absolute inset-0 flex items-center justify-center gap-4')}>
      <Loader />
      {text && <Text>{text}</Text>}
    </div>
  );
}

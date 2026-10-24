import type { ButtonProps } from '@mantine/core';
import { Button, useComputedColorScheme } from '@mantine/core';

type LoadMoreButtonProps = Omit<ButtonProps, 'children' | 'loading'> & {
  onClick: () => unknown;
  loading?: boolean;
  label?: string;
};

export function LoadMoreButton({
  onClick,
  loading,
  label = 'Load more',
  ...buttonProps
}: LoadMoreButtonProps) {
  const colorScheme = useComputedColorScheme('dark');

  return (
    <Button
      color="gray"
      variant={colorScheme === 'dark' ? 'filled' : 'light'}
      {...buttonProps}
      // Dropping the event lets callers pass `fetchNextPage` directly.
      onClick={() => onClick()}
      loading={loading}
    >
      {label}
    </Button>
  );
}

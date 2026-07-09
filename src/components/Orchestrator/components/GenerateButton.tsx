import type { ButtonProps } from '@mantine/core';
import { Button, Text } from '@mantine/core';

import { useGenerationContext } from '~/components/ImageGeneration/GenerationProvider';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useTourContext } from '~/components/Tours/ToursProvider';

export function GenerateButton({
  loading,
  children = 'Generate',
  onClick,
  disabled,
  // Legacy props — accepted for backwards compatibility but no longer used
  cost: _cost,
  error: _error,
  transactions: _transactions,
  allowMatureContent: _allowMatureContent,
  ...buttonProps
}: {
  cost?: number;
  error?: string;
  transactions?: unknown[];
  loading?: boolean;
  onClick?: (() => void) | React.MouseEventHandler<HTMLButtonElement>;
  allowMatureContent?: boolean | null;
} & ButtonProps &
  Partial<React.ButtonHTMLAttributes<HTMLButtonElement>>) {
  const canGenerate = useGenerationContext((state) => state.canGenerate);
  const { running } = useTourContext();
  const { size = 'lg' } = buttonProps;

  return (
    <LoginRedirect reason="image-gen">
      <Button
        {...buttonProps}
        size={size}
        loading={loading}
        disabled={!running && (!canGenerate || disabled)}
        onClick={onClick}
        className={buttonProps.className}
        style={{
          ...buttonProps.style,
          borderWidth: '1px 0 1px 1px',
          borderStyle: 'solid',
          borderColor: 'var(--mantine-color-default-border)',
        }}
      >
        <Text ta="center">{children}</Text>
      </Button>
    </LoginRedirect>
  );
}

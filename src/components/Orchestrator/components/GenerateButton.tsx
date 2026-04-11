import type { ButtonProps } from '@mantine/core';
import { Button, Text } from '@mantine/core';

import { useSelectedBuzzType } from '~/components/generation_v2/FormFooter';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { useGenerationContext } from '~/components/ImageGeneration/GenerationProvider';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';

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
  const { size = 'lg' } = buttonProps;

  return (
    <LoginRedirect reason="image-gen">
      <Button
        {...buttonProps}
        size={size}
        loading={loading}
        disabled={!canGenerate || disabled}
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

/**
 * Generate button colored by the user's selected buzz type.
 * For use in modals (UpscaleImageModal, UpscaleVideoModal, etc.).
 */
export function ModalSubmitButton({
  children = 'Generate',
  cost: _cost,
  ...buttonProps
}: { cost?: number } & ButtonProps & Partial<React.ButtonHTMLAttributes<HTMLButtonElement>>) {
  const { selectedType } = useSelectedBuzzType();
  const { color } = useBuzzCurrencyConfig(selectedType);

  return (
    <GenerateButton {...buttonProps} color={color}>
      {children}
    </GenerateButton>
  );
}
